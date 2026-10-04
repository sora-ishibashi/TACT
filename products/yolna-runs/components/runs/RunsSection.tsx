"use client";

// =========================
// RunsSection (SOR-54: Activity / Needs Attention / Work Detail)
// =========================
//
// TACT Runs(Canonical Execution / Permission / Attention / Work
// Correlation、SOR-49〜53)を非開発者が理解できる最小UIへ投影する
// top-level component。他のTactSection(SettingsSection等)と同じ
// 「1つのTactSection = 1つのtop-level component」構造にそのまま従う
// (新しいrouting方式は導入しない)。
//
// このcomponent自身はpermission/attention/correlationの判定を一切
// 行わない——既存API(GET /api/tact/runs/*)が返す、既に確定した
// read modelをそのまま描画するだけ(絶対条件、SOR-54指示「No business
// logic in React」)。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import ActivityTable from "./ActivityTable";
import ActivityFilters from "./ActivityFilters";
import AttentionList from "./AttentionList";
import ObservationCoverage from "./ObservationCoverage";
import WorkDetailView from "./WorkDetailView";
import CorrelationReviewModal from "./CorrelationReviewModal";
import { useRunsShell } from "@/components/shell/AppShell";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { japaneseProjection } from "@/lib/japaneseProjection";
import {
  filterActivityItems,
  distinctActivityFilterOptions,
  type ActivityItemView,
  type ActivityItemFilters,
  type AttentionCardView,
  type WorkHeaderView,
  type WorkTimelineItemView,
} from "@tact/runs-core/tact-runs-view";
import type { CaptureGap, ObservationSurface } from "@tact/runs-core/tact-execution";

type RunsView = "activity" | "attention";

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`px-3 py-2 text-[13px] font-medium transition duration-150 ease-out ${
        active
          ? "border-b-2 border-[#18B5A6] text-[#112278]"
          : "border-b-2 border-transparent text-[#626161] hover:text-[#112278]"
      }`}
    >
      {label}
    </button>
  );

}

export default function RunsSection() {

  const { user, getAccessToken } = useAuth();
  const { section } = useRunsShell();

  const [view, setView] = useState<RunsView>("activity");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  // SOR-77(CORRELATION-REVIEW-P1): レビュー対象のexecutionId(モーダル
  // 表示のtrigger)。判定・永続化ロジックは一切ここに無い
  // (CorrelationReviewModal→PATCH /api/tact/runs/execution/[id]/reclassify
  // が担う、絶対条件「No business logic in React」)。
  const [reviewingExecutionId, setReviewingExecutionId] = useState<string | null>(null);
  // SOR-23(OBS-UX-P1 Priority 3/4): filter判定はcore/tact-runs-view側の
  // pure関数(filterActivityItems())に完全委譲——ここはcontrolled state
  // を持つだけ。新しいAPI/queryは追加しない(既に読み込み済みの
  // activityItemsへのclient-side filter)。
  const [activityFilters, setActivityFilters] = useState<ActivityItemFilters>({});

  const [activityItems, setActivityItems] = useState<ActivityItemView[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [attentionItems, setAttentionItems] = useState<AttentionCardView[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ surfaces: ObservationSurface[]; gaps: CaptureGap[] }>({ surfaces: [], gaps: [] });

  const [workHeader, setWorkHeader] = useState<WorkHeaderView | null>(null);
  const [workItems, setWorkItems] = useState<WorkTimelineItemView[]>([]);
  const [workLoading, setWorkLoading] = useState(false);
  const [workError, setWorkError] = useState<string | null>(null);

  const loadActivity = useCallback(async () => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setActivityItems([]);
      setActivityLoading(false);
      return;
    }

    setActivityLoading(true);
    setActivityError(null);

    try {

      const response = await fetch("/api/tact/runs/activity", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setActivityError("Activityを読み込めませんでした。");
        setActivityItems([]);
        return;
      }

      setActivityItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setActivityError("Activityを読み込めませんでした。");
      setActivityItems([]);

    } finally {

      setActivityLoading(false);

    }

  }, [getAccessToken]);

  const loadCoverage = useCallback(async () => {
    const accessToken = getAccessToken();
    if (!accessToken) { setCoverage({ surfaces: [], gaps: [] }); return; }
    try {
      const response = await fetch("/api/tact/runs/coverage", { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.success) setCoverage({ surfaces: Array.isArray(body.surfaces) ? body.surfaces : [], gaps: Array.isArray(body.gaps) ? body.gaps : [] });
    } catch { setCoverage({ surfaces: [], gaps: [] }); }
  }, [getAccessToken]);

  const loadAttention = useCallback(async () => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setAttentionItems([]);
      setAttentionLoading(false);
      return;
    }

    setAttentionLoading(true);
    setAttentionError(null);

    try {

      // SOR-18(Human Owner指示「Active Inbox read semantics」): open単独
      // ではなくactive(open+acknowledged)を既定で取得する——
      // acknowledgeしても、resolveするまではInboxに残り続ける(reload後
      // も消えない)。resolvedはこのqueryに含まれない。
      const response = await fetch("/api/tact/runs/attention?status=active", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setAttentionError("Needs Attentionを読み込めませんでした。");
        setAttentionItems([]);
        return;
      }

      setAttentionItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setAttentionError("Needs Attentionを読み込めませんでした。");
      setAttentionItems([]);

    } finally {

      setAttentionLoading(false);

    }

  }, [getAccessToken]);

  const loadWork = useCallback(async (workId: string) => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setWorkLoading(true);
    setWorkError(null);
    setWorkHeader(null);
    setWorkItems([]);

    try {

      const response = await fetch(`/api/tact/runs/work/${encodeURIComponent(workId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setWorkError("Workを読み込めませんでした。");
        return;
      }

      setWorkHeader(body.work ?? null);
      setWorkItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setWorkError("Workを読み込めませんでした。");

    } finally {

      setWorkLoading(false);

    }

  }, [getAccessToken]);

  useEffect(() => {
    // ConnectionsPanel.tsxと同じ理由: effect本体で直接setStateへ繋がる
    // 呼び出しをせず、次のmicrotaskへ委ねる(cascading synchronous
    // render回避)。
    queueMicrotask(() => {
      void loadActivity();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => { void loadCoverage(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadAttention();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleSelectWork = useCallback((workId: string) => {
    setSelectedWorkId(workId);
    loadWork(workId);
  }, [loadWork]);

  // SOR-48(Attention Lifecycle): 状態機械・冪等性・所有権の判定は一切
  // ここに無い(PATCH /api/tact/runs/attention/[attentionId]、および
  // その先のtransitionExecutionAttention()のCAS実装が担う、絶対条件
  // 「No business logic in React」)。このhandlerはHTTP呼び出しと、
  // 結果に応じたlocal state更新だけを行う——backendのquery契約
  // (status=active)は変更せず、resolvedになったitemだけをlistから
  // 取り除く(Human Owner指示「Resolved items should not appear in the
  // default active Inbox」)。acknowledgedになったitemは(まだactiveの
  // ため)そのまま残り、returnされたAttentionCardViewでin-placeに
  // 更新する。
  const handleAttentionTransition = useCallback(async (attentionId: string, action: "acknowledge" | "resolve") => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    try {

      const response = await fetch(`/api/tact/runs/attention/${encodeURIComponent(attentionId)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success || !body.attention) {
        console.error("[RunsSection] attention transition failed", action, attentionId);
        return;
      }

      const updated = body.attention as AttentionCardView;

      setAttentionItems((prev) => {

        if (updated.status === "resolved") {
          return prev.filter((item) => item.attentionId !== attentionId);
        }

        return prev.map((item) => (item.attentionId === attentionId ? updated : item));

      });

    } catch {

      console.error("[RunsSection] attention transition failed", action, attentionId);

    }

  }, [getAccessToken]);

  // SOR-77: CorrelationReviewModalが既にサーバーへ永続化(PATCH
  // reclassify)した後の結果を、Activity一覧のlocal stateへその場で
  // 反映するだけ(絶対条件「reload preserves the correction state」:
  // 反映しなくてもreloadすれば正しい状態が返る、これはUX即時性のためだけ)。
  //
  // SOR-23: isHumanCorrectedもその場で更新する(SOR-77では未反映だった
  // ——修正直後はreloadするまでHistory導線が現れなかった)。Work Detail
  // を表示中にreclassifyした場合は、workId変更によりそのExecutionが
  // 現在のWork Timelineへ属するかどうか自体が変わりうる(Change/Keep
  // Unassignedで別Workまたは未割当になった場合)ため、個別にpatchせず
  // 素直にそのWorkを再読み込みする(既存のloadWork()をそのまま再利用、
  // 新しいstate合成ロジックを作らない)。
  const handleExecutionCorrected = useCallback((
    executionId: string,
    result: { workId: string | null; correlationStatus: ActivityItemView["correlationStatus"]; isHumanCorrected: true }
  ) => {

    setActivityItems((prev) => prev.map((item) => (
      item.executionId === executionId
        ? { ...item, workId: result.workId, correlationStatus: result.correlationStatus, isHumanCorrected: result.isHumanCorrected }
        : item
    )));

    if (selectedWorkId) {
      loadWork(selectedWorkId);
    }

  }, [selectedWorkId, loadWork]);

  const handleBack = useCallback(() => {
    setSelectedWorkId(null);
    setWorkHeader(null);
    setWorkItems([]);
    setWorkError(null);
  }, []);

  // SOR-23: filter選択肢は現在読み込まれているactivityItemsから毎回
  // 導出する(推測・hardcodeしない、pure関数、core/tact-runs-view参照)。
  const activityFilterOptions = useMemo(() => distinctActivityFilterOptions(activityItems), [activityItems]);
  const filteredActivityItems = useMemo(
    () => filterActivityItems(activityItems, activityFilters),
    [activityItems, activityFilters]
  );
  const unavailableTitle = section === "work" ? "仕事" : section === "agent" ? "AI" : section === "permission" ? "権限" : null;
  const displayedView: RunsView = section === "attention" ? "attention" : section === "activity" || section === "home" ? "activity" : view;

  if (!user) {

    return (
      <div className="flex h-full min-w-0 flex-1 flex-col px-6 py-5">
        <p className="text-[13px] leading-[18px] text-[#626161]">
          ログイン後にRunsを確認できます。
        </p>
      </div>
    );

  }

  if (selectedWorkId) {

    return (

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">

        {workLoading ? (
          <p className="text-[13px] leading-[18px] text-[#626161]">読み込んでいます...</p>
        ) : workError ? (
          <p className="text-[13px] leading-[18px] text-[#C53F4B]">{workError}</p>
        ) : workHeader ? (
          <WorkDetailView work={workHeader} items={workItems} onBack={handleBack} onReviewCorrelation={setReviewingExecutionId} />
        ) : (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={handleBack}
              className="w-fit text-[12px] text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
            >
              ← Back
            </button>
            <p className="text-[13px] leading-[18px] text-[#626161]">このWorkは見つかりませんでした。</p>
          </div>
        )}

        {reviewingExecutionId && getAccessToken() && (
          <CorrelationReviewModal
            executionId={reviewingExecutionId}
            accessToken={getAccessToken()!}
            onClose={() => setReviewingExecutionId(null)}
            onCorrected={(result) => handleExecutionCorrected(reviewingExecutionId, result)}
          />
        )}

      </div>

    );

  }

  return (

    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SecondarySidebar
        title={section === "attention" ? japaneseProjection("Attention") : section === "coverage" ? "接続・観測" : unavailableTitle ?? japaneseProjection("Activity")}
        summary={section === "attention" ? `${attentionItems.length}件` : section === "activity" || section === "home" ? `${activityItems.length}件` : undefined}
      >
        {unavailableTitle ? (
          <p className="text-[12px] leading-[18px] text-[#626161]">この画面に対応するread modelは、まだ利用できません。</p>
        ) : section === "attention" ? (
          <p className="text-[12px] leading-[18px] text-[#626161]">要確認のカテゴリと件数は、現在のread modelから表示します。</p>
        ) : section === "coverage" ? (
          <p className="text-[12px] leading-[18px] text-[#626161]">観測の健全性と欠損は、接続・観測のread modelで確認できます。</p>
        ) : (
          <ActivityFilters filters={activityFilters} options={activityFilterOptions} onChange={setActivityFilters} />
        )}
      </SecondarySidebar>
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6">

      <h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">{unavailableTitle ?? (section === "attention" ? "要確認" : section === "coverage" ? "接続・観測" : section === "home" ? "ホーム" : "実行記録")}</h1>

      {!unavailableTitle && <div role="tablist" aria-label="Runs" className="mt-4 flex gap-1 border-b border-[#D9D9D9]">
        <TabButton active={displayedView === "activity"} onClick={() => setView("activity")} label="実行記録" />
        <TabButton
          active={displayedView === "attention"}
          onClick={() => setView("attention")}
          label={attentionItems.length > 0 ? `Needs Attention (${attentionItems.length})` : "Needs Attention"}
        />
      </div>}

      {/* SOR-23 compact-width fix: this div is a flex item of the root
          (flex flex-col above) — same min-width:auto default as any other
          flex item. Without min-w-0 here, the 880px ActivityTable several
          levels below still forces this (and everything above it) wider
          than the viewport, even after fixing TactShell alone. */}
      <div className="mt-4 min-w-0">

        {unavailableTitle ? (
          <section className="rounded-xl border border-[#D9D9D9] bg-[#F2F2F2]/40 p-4" aria-label="利用不可のread model"><p className="text-[13px] text-[#112278]">表示できるデータはありません</p><p className="mt-1 text-[12px] leading-[18px] text-[#626161]">read modelが用意されるまで、架空の件数や状態は表示しません。</p></section>
        ) : section === "coverage" ? (
          <ObservationCoverage surfaces={coverage.surfaces} gaps={coverage.gaps} />
        ) : displayedView === "activity" ? (

          activityLoading ? (
            <p className="text-[13px] leading-[18px] text-[#626161]">読み込んでいます...</p>
          ) : activityError ? (
            <p className="text-[13px] leading-[18px] text-[#C53F4B]">{activityError}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {activityItems.length > 0 && filteredActivityItems.length === 0 ? (
                <p className="text-[13px] leading-[18px] text-[#626161]">
                  条件に一致するExecutionはありません。
                </p>
              ) : (
                <ActivityTable items={filteredActivityItems} onSelectWork={handleSelectWork} onReviewCorrelation={setReviewingExecutionId} />
              )}
            </div>
          )

        ) : (

          attentionLoading ? (
            <p className="text-[13px] leading-[18px] text-[#626161]">読み込んでいます...</p>
          ) : attentionError ? (
            <p className="text-[13px] leading-[18px] text-[#C53F4B]">{attentionError}</p>
          ) : (
            <AttentionList items={attentionItems} onSelectWork={handleSelectWork} onTransition={handleAttentionTransition} />
          )

        )}

      </div>

      {section !== "coverage" && !unavailableTitle && <ObservationCoverage surfaces={coverage.surfaces} gaps={coverage.gaps} />}

      {reviewingExecutionId && getAccessToken() && (
        <CorrelationReviewModal
          executionId={reviewingExecutionId}
          accessToken={getAccessToken()!}
          onClose={() => setReviewingExecutionId(null)}
          onCorrected={(result) => handleExecutionCorrected(reviewingExecutionId, result)}
        />
      )}

      </div>
    </div>

  );

}
