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

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import ActivityTable from "./ActivityTable";
import AttentionList from "./AttentionList";
import WorkDetailView from "./WorkDetailView";
import CorrelationReviewModal from "./CorrelationReviewModal";
import type { ActivityItemView, AttentionCardView, WorkHeaderView, WorkTimelineItemView } from "@/core/tact-runs-view";

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

  const [view, setView] = useState<RunsView>("activity");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  // SOR-77(CORRELATION-REVIEW-P1): レビュー対象のexecutionId(モーダル
  // 表示のtrigger)。判定・永続化ロジックは一切ここに無い
  // (CorrelationReviewModal→PATCH /api/tact/runs/execution/[id]/reclassify
  // が担う、絶対条件「No business logic in React」)。
  const [reviewingExecutionId, setReviewingExecutionId] = useState<string | null>(null);

  const [activityItems, setActivityItems] = useState<ActivityItemView[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [attentionItems, setAttentionItems] = useState<AttentionCardView[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [attentionError, setAttentionError] = useState<string | null>(null);

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
  const handleExecutionCorrected = useCallback((
    executionId: string,
    result: { workId: string | null; correlationStatus: ActivityItemView["correlationStatus"] }
  ) => {

    setActivityItems((prev) => prev.map((item) => (
      item.executionId === executionId
        ? { ...item, workId: result.workId, correlationStatus: result.correlationStatus }
        : item
    )));

  }, []);

  const handleBack = useCallback(() => {
    setSelectedWorkId(null);
    setWorkHeader(null);
    setWorkItems([]);
    setWorkError(null);
  }, []);

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
          <WorkDetailView work={workHeader} items={workItems} onBack={handleBack} />
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

      </div>

    );

  }

  return (

    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">

      <h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">Runs</h1>

      <div role="tablist" aria-label="Runs" className="mt-4 flex gap-1 border-b border-[#D9D9D9]">
        <TabButton active={view === "activity"} onClick={() => setView("activity")} label="Activity" />
        <TabButton
          active={view === "attention"}
          onClick={() => setView("attention")}
          label={attentionItems.length > 0 ? `Needs Attention (${attentionItems.length})` : "Needs Attention"}
        />
      </div>

      <div className="mt-4">

        {view === "activity" ? (

          activityLoading ? (
            <p className="text-[13px] leading-[18px] text-[#626161]">読み込んでいます...</p>
          ) : activityError ? (
            <p className="text-[13px] leading-[18px] text-[#C53F4B]">{activityError}</p>
          ) : (
            <ActivityTable items={activityItems} onSelectWork={handleSelectWork} onReviewCorrelation={setReviewingExecutionId} />
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
