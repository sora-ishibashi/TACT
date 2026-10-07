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
import { ActivityExplorer } from "./ActivityExplorer";
import ActivityFilters from "./ActivityFilters";
import AttentionInbox from "./AttentionInbox";
import { PermissionManagementPeek, PermissionManagementView } from "./PermissionManagementView";
import { AgentManagementPeek, AgentManagementView } from "./AgentManagementView";
import { ConnectionObservationPeek, ConnectionObservationView } from "./ConnectionObservationView";
import { ManagementSidebar, type ManagementSection } from "./ManagementSidebar";
import { HomeView } from "./HomeView";
import { WorkSidebar, type WorkListItem } from "./WorkSidebar";
import WorkDetailView from "./WorkDetailView";
import CorrelationReviewModal from "./CorrelationReviewModal";
import { ExecutionInspector } from "./ExecutionInspector";
import { useRunsShell } from "@/components/shell/AppShell";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, presentationStateForHttp, type PresentationStateKind } from "@/components/shell/PresentationState";
import { PageHeader } from "@/components/shell/ShellContainers";
import { summarizeActivityStatuses } from "@/lib/statusPresentation";
import SettingsView from "./SettingsView";
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
import { attentionReasonJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import type { PermissionScopeView } from "@tact/runs-core/tact-runs-view/permissionManagement";
import type {
  AgentManagementDetailView,
  AgentManagementItemView,
} from "@tact/runs-core/tact-runs-view/agentManagement";
import {
  buildCoverageServiceDetails,
  type ConnectionReadState,
  type PublicConnection,
} from "@tact/runs-core/tact-runs-view/coverageManagement";

const EMPTY_COVERAGE: { surfaces: ObservationSurface[]; gaps: CaptureGap[]; connectionReadState: ConnectionReadState; connections: PublicConnection[] } =
  { surfaces: [], gaps: [], connectionReadState: "unavailable", connections: [] };

export default function RunsSection() {

  const { user, getAccessToken, signOut } = useAuth();
  const { section, setSection } = useRunsShell();

  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  // SOR-77(CORRELATION-REVIEW-P1): レビュー対象のexecutionId(モーダル
  // 表示のtrigger)。判定・永続化ロジックは一切ここに無い
  // (CorrelationReviewModal→PATCH /api/tact/runs/execution/[id]/reclassify
  // が担う、絶対条件「No business logic in React」)。
  const [reviewingExecutionId, setReviewingExecutionId] = useState<string | null>(null);
  // One shared selection boundary: Work/Attention/other screens can pass an
  // execution id here without owning a second detail implementation.
  const [inspectedExecutionId, setInspectedExecutionId] = useState<string | null>(null);
  const [managementDetailPeek, setManagementDetailPeek] = useState<"agent" | "permission" | "coverage" | null>(null);
  const [managementSection, setManagementSection] = useState<ManagementSection>("agent");
  // SOR-23(OBS-UX-P1 Priority 3/4): filter判定はcore/tact-runs-view側の
  // pure関数(filterActivityItems())に完全委譲——ここはcontrolled state
  // を持つだけ。新しいAPI/queryは追加しない(既に読み込み済みの
  // activityItemsへのclient-side filter)。
  const [activityFilters, setActivityFilters] = useState<ActivityItemFilters>({});
  const [attentionCategory, setAttentionCategory] = useState<AttentionCardView["attentionReason"] | null>(null);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);
  const [selectedPermissionScopeKey, setSelectedPermissionScopeKey] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const [activityItems, setActivityItems] = useState<ActivityItemView[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<PresentationStateKind | null>(null);

  const [attentionItems, setAttentionItems] = useState<AttentionCardView[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [attentionError, setAttentionError] = useState<PresentationStateKind | null>(null);
  const [coverage, setCoverage] = useState(EMPTY_COVERAGE);
  const [coverageLoading, setCoverageLoading] = useState(true);
  const [coverageError, setCoverageError] = useState<PresentationStateKind | null>(null);
  const [permissionScopes, setPermissionScopes] = useState<PermissionScopeView[]>([]);
  const [permissionLoading, setPermissionLoading] = useState(true);
  const [permissionError, setPermissionError] = useState<PresentationStateKind | null>(null);
  const [agentItems, setAgentItems] = useState<AgentManagementItemView[]>([]);
  const [agentDetails, setAgentDetails] = useState<AgentManagementDetailView[]>([]);
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState<PresentationStateKind | null>(null);
  const [workList, setWorkList] = useState<WorkListItem[]>([]);
  const [workListLoading, setWorkListLoading] = useState(true);
  const [workListError, setWorkListError] = useState<PresentationStateKind | null>(null);
  const [workSearch, setWorkSearch] = useState("");

  const [workHeader, setWorkHeader] = useState<WorkHeaderView | null>(null);
  const [workItems, setWorkItems] = useState<WorkTimelineItemView[]>([]);
  const [workLoading, setWorkLoading] = useState(false);
  const [workError, setWorkError] = useState<PresentationStateKind | "not-found" | null>(null);

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
        setActivityError(presentationStateForHttp(response.status));
        setActivityItems([]);
        return;
      }

      setActivityItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setActivityError("error");
      setActivityItems([]);

    } finally {

      setActivityLoading(false);

    }

  }, [getAccessToken]);

  const loadWorkList = useCallback(async () => {
    const accessToken = getAccessToken();
    if (!accessToken) { setWorkList([]); setWorkListError("permission-denied"); setWorkListLoading(false); return; }
    setWorkListLoading(true);
    setWorkListError(null);
    try {
      const response = await fetch("/api/tact/runs/work", { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        setWorkList([]);
        setWorkListError(presentationStateForHttp(response.status));
        return;
      }
      setWorkList(Array.isArray(body.items) ? body.items : []);
    } catch {
      setWorkList([]);
      setWorkListError("error");
    } finally { setWorkListLoading(false); }
  }, [getAccessToken]);

  const loadCoverage = useCallback(async () => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setCoverage(EMPTY_COVERAGE);
      setCoverageError("permission-denied");
      setCoverageLoading(false);
      return;
    }

    setCoverageLoading(true);
    setCoverageError(null);

    try {

      const response = await fetch("/api/tact/runs/coverage", { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setCoverageError(presentationStateForHttp(response.status));
        setCoverage(EMPTY_COVERAGE);
        return;
      }

      setCoverage({
        surfaces: Array.isArray(body.surfaces) ? body.surfaces : [],
        gaps: Array.isArray(body.gaps) ? body.gaps : [],
        connectionReadState: body.connectionReadState === "available" ? "available" : "unavailable",
        connections: Array.isArray(body.connections) ? body.connections : [],
      });

    } catch {

      setCoverageError("error");
      setCoverage(EMPTY_COVERAGE);

    } finally {

      setCoverageLoading(false);

    }

  }, [getAccessToken]);

  const loadPermissionManagement = useCallback(async () => {
    const accessToken = getAccessToken();
    if (!accessToken) { setPermissionScopes([]); setPermissionLoading(false); return; }
    setPermissionLoading(true);
    setPermissionError(null);
    try {
      const response = await fetch("/api/tact/runs/permission-management", { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        setPermissionError(presentationStateForHttp(response.status));
        setPermissionScopes([]);
        return;
      }
      setPermissionScopes(Array.isArray(body.scopes) ? body.scopes : []);
    } catch {
      setPermissionError("error");
      setPermissionScopes([]);
    } finally {
      setPermissionLoading(false);
    }
  }, [getAccessToken]);

  const loadAgentManagement = useCallback(async () => {
    const accessToken = getAccessToken();
    if (!accessToken) { setAgentItems([]); setAgentDetails([]); setAgentLoading(false); return; }
    setAgentLoading(true);
    setAgentError(null);
    try {
      const response = await fetch("/api/tact/runs/agent-management", { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        setAgentError(presentationStateForHttp(response.status));
        setAgentItems([]);
        setAgentDetails([]);
        return;
      }
      setAgentItems(Array.isArray(body.items) ? body.items : []);
      setAgentDetails(Array.isArray(body.details) ? body.details : []);
    } catch {
      setAgentError("error");
      setAgentItems([]);
      setAgentDetails([]);
    } finally {
      setAgentLoading(false);
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
        setAttentionError(presentationStateForHttp(response.status));
        setAttentionItems([]);
        return;
      }

      setAttentionItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setAttentionError("error");
      setAttentionItems([]);

    } finally {

      setAttentionLoading(false);

    }

  }, [getAccessToken]);

  const loadWork = useCallback(async (workId: string) => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setWorkError("permission-denied");
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
        setWorkError(response.status === 404 ? "not-found" : presentationStateForHttp(response.status));
        return;
      }

      setWorkHeader(body.work ?? null);
      setWorkItems(Array.isArray(body.items) ? body.items : []);

    } catch {

      setWorkError("error");

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
    queueMicrotask(() => { void loadPermissionManagement(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => { void loadAgentManagement(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => { void loadWorkList(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadAttention();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    // A detail surface belongs to the section that opened it. Selection and
    // filter state remain intact, but overlays never cross a primary-nav boundary.
    queueMicrotask(() => {
      setInspectedExecutionId(null);
      setReviewingExecutionId(null);
      setManagementDetailPeek(null);
    });
  }, [section]);

  useEffect(() => {
    queueMicrotask(() => {
      setInspectedExecutionId(null);
      setManagementDetailPeek(null);
    });
  }, [managementSection]);

  const handleSelectWork = useCallback((workId: string) => {
    setSelectedWorkId(workId);
    setSection("work");
    loadWork(workId);
  }, [loadWork, setSection]);

  const handleSelectExecution = useCallback((executionId: string) => {
    setManagementDetailPeek(null);
    setInspectedExecutionId(executionId);
  }, []);

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

  // SOR-23: filter選択肢は現在読み込まれているactivityItemsから毎回
  // 導出する(推測・hardcodeしない、pure関数、core/tact-runs-view参照)。
  const activityFilterOptions = useMemo(() => distinctActivityFilterOptions(activityItems), [activityItems]);
  const filteredActivityItems = useMemo(
    () => filterActivityItems(activityItems, activityFilters),
    [activityItems, activityFilters]
  );
  const attentionExecutionIds = useMemo(
    () => new Set(attentionItems.map((item) => item.executionId)),
    [attentionItems]
  );
  const activityStatusSummary = useMemo(() => summarizeActivityStatuses(activityItems), [activityItems]);
  const attentionCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of attentionItems) counts.set(item.attentionReason, (counts.get(item.attentionReason) ?? 0) + 1);
    return [...counts].map(([id, count]) => ({ id: id as AttentionCardView["attentionReason"], count, label: attentionReasonJapanese(id as AttentionCardView["attentionReason"]) }));
  }, [attentionItems]);
  const filteredAttentionItems = useMemo(() => attentionCategory ? attentionItems.filter((item) => item.attentionReason === attentionCategory) : attentionItems, [attentionCategory, attentionItems]);
  // SOR-187: pure projection (coverageManagement.ts) — classification/
  // join判定は一切ここに無い、既存surfaces/gaps/connectionsをそのまま渡す。
  const coverageDetails = useMemo(
    () => buildCoverageServiceDetails({ surfaces: coverage.surfaces, gaps: coverage.gaps, connectionReadState: coverage.connectionReadState, connections: coverage.connections }),
    [coverage.surfaces, coverage.gaps, coverage.connectionReadState, coverage.connections]
  );
  // One SOR-185 inspector instance is shared by Activity and Work Timeline.
  const executionInspector = (
    <ExecutionInspector
      executionId={inspectedExecutionId}
      accessToken={getAccessToken()}
      onClose={() => setInspectedExecutionId(null)}
    />
  );
  if (!user) {

    return (
      <div className="flex h-full min-w-0 flex-1 flex-col px-6 py-5">
        <p className="text-sm leading-[18px] text-runs-text-secondary">
          ログイン後にRunsを確認できます。
        </p>
      </div>
    );

  }

  return (

    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {section === "work" && <WorkSidebar items={workList} state={workListLoading ? "loading" : workListError} selectedWorkId={selectedWorkId} search={workSearch} onSearch={setWorkSearch} onSelect={handleSelectWork} />}
      {section === "management" && <ManagementSidebar section={managementSection} agents={agentItems} permissions={permissionScopes} details={coverageDetails} selectedAgentId={selectedAgentId} selectedScopeKey={selectedPermissionScopeKey} selectedSurfaceId={selectedSurfaceId} onSectionChange={setManagementSection} onSelectAgent={setSelectedAgentId} onSelectPermission={setSelectedPermissionScopeKey} onSelectSurface={setSelectedSurfaceId} />}
      {(section === "activity" || section === "attention") && <SecondarySidebar title={section === "attention" ? "要確認" : "実行記録のフィルタ"}>
        {section === "activity" ? <ActivityFilters filters={activityFilters} options={activityFilterOptions} onChange={setActivityFilters} /> : null}
        {section === "attention" ? <div className="flex flex-col gap-0.5"><p className="mb-1 px-2 text-xs font-semibold tracking-wide text-runs-muted">理由</p><button type="button" onClick={() => setAttentionCategory(null)} aria-pressed={attentionCategory === null} className={`border-l-2 px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${attentionCategory === null ? "border-runs-interactive bg-runs-selected font-semibold text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}>すべて <span className="float-right tabular-nums">{attentionItems.length}</span></button>{attentionCategories.map((category) => <button key={category.id} type="button" onClick={() => setAttentionCategory(category.id)} aria-pressed={attentionCategory === category.id} className={`border-l-2 px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${attentionCategory === category.id ? "border-runs-interactive bg-runs-selected font-semibold text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}>{category.label}<span className="float-right tabular-nums">{category.count}</span></button>)}</div> : null}
      </SecondarySidebar>}
      <div className="tact-scrollbar min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 lg:px-6">
      {(section === "home" || section === "attention" || section === "activity") && <PageHeader title={section === "home" ? "ホーム" : section === "attention" ? "要確認" : "実行記録"} />}

      {/* Keeps all list variants shrinkable within the main scroll region. */}
      <div className={`${section === "home" || section === "attention" || section === "activity" ? "mt-4" : ""} min-w-0`}>

        {section === "home" ? <HomeView attention={attentionItems} attentionState={attentionLoading ? "loading" : attentionError} works={workList} worksState={workListLoading ? "loading" : workListError} surfaces={coverage.surfaces} gaps={coverage.gaps} activityStatusSummary={activityStatusSummary} onSelectWork={handleSelectWork} onOpenAttention={() => setSection("attention")} /> : section === "work" ? (
          !selectedWorkId ? <p className="text-sm text-runs-text-secondary">左の一覧からWorkを選択してください。</p> : workLoading ? <PresentationState kind="loading" /> : workError ? (workError === "not-found" ? <PresentationState kind="empty">Workが見つかりません。</PresentationState> : <PresentationState kind={workError} />) : workHeader ? <WorkDetailView work={workHeader} items={workItems} onReviewCorrelation={setReviewingExecutionId} onSelectExecution={handleSelectExecution} /> : <PresentationState kind="empty">Workが見つかりません。</PresentationState>
        ) : section === "management" ? (
          managementSection === "agent" ? <AgentManagementView items={agentItems} details={agentDetails} state={agentLoading ? "loading" : agentError} selectedAgentId={selectedAgentId} onOpenDetails={() => setManagementDetailPeek("agent")} onSelectWork={handleSelectWork} onSelectExecution={handleSelectExecution} onOpenPermission={(exactScopeKey) => { if (exactScopeKey) setSelectedPermissionScopeKey(exactScopeKey); setManagementSection("permission"); }} onOpenAttention={() => setSection("attention")} />
            : managementSection === "permission" ? <PermissionManagementView scopes={permissionScopes} state={permissionLoading ? "loading" : permissionError} selectedScopeKey={selectedPermissionScopeKey} onOpenDetails={() => setManagementDetailPeek("permission")} onSelectExecution={handleSelectExecution} onSelectWork={handleSelectWork} />
              : <ConnectionObservationView details={coverageDetails} state={coverageLoading ? "loading" : coverageError} selectedSurfaceId={selectedSurfaceId} mode={managementSection} onOpenDetails={() => setManagementDetailPeek("coverage")} />
        ) : section === "activity" ? (

          activityLoading ? (
            <PresentationState kind="loading" />
          ) : activityError ? (
            <PresentationState kind={activityError} />
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {activityItems.length > 0 && filteredActivityItems.length === 0 ? (
                <PresentationState kind="empty" />
              ) : (
                <ActivityExplorer items={filteredActivityItems} attentionExecutionIds={attentionExecutionIds} selectedExecutionId={inspectedExecutionId} onSelectWork={handleSelectWork} onReviewCorrelation={setReviewingExecutionId} onSelectExecution={handleSelectExecution} />
              )}
            </div>
          )

        ) : section === "attention" ? (

          attentionLoading ? (
            <PresentationState kind="loading" />
          ) : attentionError ? (
            <PresentationState kind={attentionError} />
          ) : (
            filteredAttentionItems.length === 0 ? <PresentationState kind="empty" /> : <AttentionInbox items={filteredAttentionItems} onSelectWork={handleSelectWork} onSelectExecution={handleSelectExecution} onOpenPermissionSettings={() => { setManagementSection("permission"); setSection("management"); }} onTransition={handleAttentionTransition} />
          )

        ) : <SettingsView email={user.email ?? ""} onSignOut={signOut} />}

      </div>

      {reviewingExecutionId && getAccessToken() && (
        <CorrelationReviewModal
          executionId={reviewingExecutionId}
          accessToken={getAccessToken()!}
          onClose={() => setReviewingExecutionId(null)}
          onCorrected={(result) => handleExecutionCorrected(reviewingExecutionId, result)}
        />
      )}

      {executionInspector}

      {section === "management" && managementSection === "agent" && managementDetailPeek === "agent" && selectedAgentId && !inspectedExecutionId && <AgentManagementPeek items={agentItems} details={agentDetails} state={agentLoading ? "loading" : agentError} selectedAgentId={selectedAgentId} onClose={() => setManagementDetailPeek(null)} onOpenPermission={(exactScopeKey) => { if (exactScopeKey) setSelectedPermissionScopeKey(exactScopeKey); setManagementSection("permission"); }} />}
      {section === "management" && managementSection === "permission" && managementDetailPeek === "permission" && selectedPermissionScopeKey && !inspectedExecutionId && <PermissionManagementPeek scopes={permissionScopes} state={permissionLoading ? "loading" : permissionError} selectedScopeKey={selectedPermissionScopeKey} onClose={() => setManagementDetailPeek(null)} onSelectExecution={handleSelectExecution} onSelectWork={handleSelectWork} />}
      {section === "management" && (managementSection === "connection" || managementSection === "observation") && managementDetailPeek === "coverage" && selectedSurfaceId && <ConnectionObservationPeek details={coverageDetails} state={coverageLoading ? "loading" : coverageError} selectedSurfaceId={selectedSurfaceId} onClose={() => setManagementDetailPeek(null)} />}

      </div>
    </div>

  );

}
