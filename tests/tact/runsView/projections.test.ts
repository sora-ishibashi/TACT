// =========================
// TACT Runs UI — Read-Model Projection Tests (SOR-54)
// =========================
//
// 対象: core/tact-runs-view/index.ts の純粋変換関数群。
// SOR-54指示「Required tests」に対応する。この moduleはDBアクセスを
// 持たないため、fixture(CanonicalExecution / AttentionItemView /
// Work)を直接組み立てて各 toXView() / label() 関数へ渡すだけで
// 検証できる——real Supabaseは不要(SOR-56の対象外)。

import {
  principalLabel,
  agentLabel,
  targetSystemLabel,
  actionLabel,
  permissionResultLabel,
  executionResultLabel,
  attentionReasonLabel,
  workStatusLabel,
  toCanonicalPermissionResultFromExecutionStatus,
  toActivityItemView,
  toAttentionCardView,
  toWorkTimelineItemView,
  toWorkHeaderView,
  ACTIVITY_ITEM_VIEW_KEYS,
  WORK_TIMELINE_ITEM_VIEW_KEYS,
} from "../../../core/tact-runs-view";
import type {
  CanonicalExecution,
  ExecutionPermissionStatus,
  ExecutionCorrelationStatus,
} from "../../../core/tact-execution/types";
import type { AttentionItemView } from "../../../core/tact-execution/permission/attentionStore";
import type { Work } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

// =========================
// Fixture builders (test-only。production codeへのhardcodeは禁止 —
// SOR-54指示「production hardcodeは禁止。test fixture / dev seedのみ」)
// =========================

function baseExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "unresolved",
    connectionId: null,
    actorKind: "human",
    actorId: "Sora",
    agentId: "Claude Test Agent",
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "mcp",
    sourceType: "webhook",
    externalEventId: "evt-1",
    adapterVersion: "1",
    sourceMetadata: null,
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "read",
    operation: "notion_read",
    resourceType: "page",
    resourceIdentifier: "page-1",
    targetProvider: "notion",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "allowed",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: null,
    observedAt: "2026-09-24T00:00:00.000Z",
    persistedAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function baseAttentionItem(overrides: Partial<AttentionItemView> = {}): AttentionItemView {
  return {
    attentionId: "attn-1",
    executionId: "exec-1",
    reason: "approval_required",
    status: "open",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    permissionEvaluation: {
      status: "approval_required",
      reasonCode: "notion-ai-agent-update-page-approval-required",
      policyId: "notion-ai-agent-update-page-approval-required",
      evaluatorVersion: "1",
      evaluatedAt: "2026-09-24T00:00:00.000Z",
    },
    actor: { kind: "human", id: "Sora" },
    agentId: "Claude Test Agent",
    provider: "mcp",
    targetProvider: "notion",
    action: {
      actionCategory: "update",
      operation: "notion_update_page",
      resourceType: "page",
      resourceIdentifier: "page-1",
    },
    executionStatus: "succeeded",
    workId: null,
    workTitle: null,
    acknowledgedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

function baseWork(overrides: Partial<Pick<Work, "id" | "title" | "status">> = {}): Pick<Work, "id" | "title" | "status"> {
  return {
    id: "W-001",
    title: "Example Work",
    status: "running",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // Screen 1: Activity — permission result rendering
  // =========================

  results.push(check(
    "[Required test] permissionStatus=allowed -> ActivityItemView.permissionEvaluation=MATCH",
    toActivityItemView(baseExecution({ permissionStatus: "allowed" }), null, false).permissionEvaluation === "MATCH"
  ));

  results.push(check(
    "[Required test] permissionStatus=approval_required -> APPROVAL_REQUIRED",
    toActivityItemView(baseExecution({ permissionStatus: "approval_required" }), null, false).permissionEvaluation === "APPROVAL_REQUIRED"
  ));

  results.push(check(
    "[Required test] permissionStatus=denied -> MISMATCH",
    toActivityItemView(baseExecution({ permissionStatus: "denied" }), null, false).permissionEvaluation === "MISMATCH"
  ));

  results.push(check(
    "[Required test] permissionStatus=unknown -> UNKNOWN",
    toActivityItemView(baseExecution({ permissionStatus: "unknown" }), null, false).permissionEvaluation === "UNKNOWN"
  ));

  results.push(check(
    "[Required test] permissionStatus=pending (未評価) -> UNKNOWN として表す(推測しない)",
    toCanonicalPermissionResultFromExecutionStatus("pending" as ExecutionPermissionStatus) === "UNKNOWN"
  ));

  // =========================
  // Screen 1: Activity — succeeded/failed distinction
  // =========================

  results.push(check(
    "[Required test] status=succeeded -> \"Succeeded\"",
    toActivityItemView(baseExecution({ status: "succeeded" }), null, false).executionStatus === "succeeded"
    && executionResultLabel("succeeded") === "Succeeded"
  ));

  results.push(check(
    "[Required test] status=failed -> \"Failed\"",
    toActivityItemView(baseExecution({ status: "failed" }), null, false).executionStatus === "failed"
    && executionResultLabel("failed") === "Failed"
  ));

  // =========================
  // Screen 1: Activity — correlated/ambiguous/unassigned distinction
  // =========================

  results.push(check(
    "[Required test] correlationStatus=matched -> CORRELATED",
    toActivityItemView(baseExecution({ workId: "W-001", correlationStatus: "matched" }), null, false).correlationStatus === "CORRELATED"
  ));

  results.push(check(
    "[Required test] correlationStatus=ambiguous -> AMBIGUOUS",
    toActivityItemView(baseExecution({ correlationStatus: "ambiguous" }), null, false).correlationStatus === "AMBIGUOUS"
  ));

  results.push(check(
    "[Required test] correlationStatus=unresolved -> UNASSIGNED",
    toActivityItemView(baseExecution({ correlationStatus: "unresolved" }), null, false).correlationStatus === "UNASSIGNED"
  ));

  results.push(check(
    "[Required test] correlationStatus=pending(未評価) も UNASSIGNED として表す(unresolvedと区別してUIへ露出しない)",
    toActivityItemView(baseExecution({ correlationStatus: "pending" as ExecutionCorrelationStatus }), null, false).correlationStatus === "UNASSIGNED"
  ));

  // ---- SOR-77 live Staging verification UX gap fix: a CORRELATED row that
  // was human-corrected must carry isHumanCorrected=true (the caller derives
  // this from append-only correlation history; this file only carries the
  // value through) so Activity can keep a Review/History affordance for it,
  // while an auto-matched row (never touched by a human) stays false. ----
  results.push(check(
    "[SOR-77] a human-corrected CORRELATED row carries isHumanCorrected=true",
    toActivityItemView(baseExecution({ workId: "W-001", correlationStatus: "matched" }), null, true).isHumanCorrected === true
  ));

  results.push(check(
    "[SOR-77] an auto-matched CORRELATED row (never touched by a human) carries isHumanCorrected=false",
    toActivityItemView(baseExecution({ workId: "W-001", correlationStatus: "matched" }), null, false).isHumanCorrected === false
  ));

  // =========================
  // Provider / targetSystem display
  // =========================

  results.push(check(
    "[Required test] provider=mcp / targetProvider=notion -> label=\"Notion\"、subLabel=\"via MCP\"(生のmcpを主表示にしない)",
    (() => {
      const t = targetSystemLabel("mcp", "notion");
      return t.label === "Notion" && t.subLabel === "via MCP";
    })()
  ));

  results.push(check(
    "[Required test] provider=slack(targetProviderなし) -> subLabelは付与しない",
    targetSystemLabel("slack", null).subLabel === null
  ));

  results.push(check(
    "[Required test] provider=mcp / targetProvider=mcp(実質同一) -> \"via MCP\" sublabelは付けない",
    targetSystemLabel("mcp", "mcp").subLabel === null
  ));

  results.push(check(
    "[Required test] actionLabel: 対象system接頭辞を取り除き大文字化する(notion_update_page -> UPDATE_PAGE)",
    actionLabel("notion_update_page", "mcp", "notion") === "UPDATE_PAGE"
  ));

  results.push(check(
    "[Required test] actionLabel: 一致する接頭辞が無い場合はそのまま大文字化する",
    actionLabel("app_mention", "slack", null) === "APP_MENTION"
  ));

  // =========================
  // Principal / Agent fallback (空欄にしない、推測しない)
  // =========================

  results.push(check(
    "[Required test] actorId=null -> \"Unknown principal\"",
    principalLabel(null) === "Unknown principal"
  ));

  results.push(check(
    "[Required test] actorId=\"\"(空文字) -> \"Unknown principal\"(空欄のまま出さない)",
    principalLabel("") === "Unknown principal"
  ));

  results.push(check(
    "[Required test] agentId=null -> \"Unknown agent\"",
    agentLabel(null) === "Unknown agent"
  ));

  results.push(check(
    "[Required test] actorId=\"Sora\" -> そのまま\"Sora\"(存在するidを勝手に別表示名へ変換しない)",
    principalLabel("Sora") === "Sora"
  ));

  // =========================
  // Screen 2: Needs Attention
  // =========================

  results.push(check(
    "[Required test] Attention reason=approval_required -> \"Approval required\"バッジ",
    attentionReasonLabel("approval_required") === "Approval required"
    && toAttentionCardView(baseAttentionItem({ reason: "approval_required" })).attentionReasonLabel === "Approval required"
  ));

  results.push(check(
    "[Required test] Attention reason=permission_mismatch -> \"Permission mismatch\"バッジ",
    attentionReasonLabel("permission_mismatch") === "Permission mismatch"
  ));

  results.push(check(
    "[Required test] AttentionCardView.permissionEvaluation は元decision status(approval_required)からcanonical変換される",
    toAttentionCardView(baseAttentionItem({
      permissionEvaluation: {
        status: "approval_required",
        reasonCode: "r",
        policyId: null,
        evaluatorVersion: "1",
        evaluatedAt: "2026-09-24T00:00:00.000Z",
      },
    })).permissionEvaluation === "APPROVAL_REQUIRED"
  ));

  results.push(check(
    "[Required test] Attention workId=null -> AttentionCardView.workId=null(誤ったWorkへ紐付けない)",
    toAttentionCardView(baseAttentionItem({ workId: null })).workId === null
  ));

  results.push(check(
    "[Required test] Attention workId=W-001(後からWork Correlationが確定した場合) -> そのままworkIdを反映する",
    toAttentionCardView(baseAttentionItem({ workId: "W-001" })).workId === "W-001"
  ));

  results.push(check(
    "[Required test] AttentionCardView.status はSOR-52のAttentionItewView.statusをそのまま透過する(独自に再判定しない)",
    toAttentionCardView(baseAttentionItem({ status: "acknowledged" })).status === "acknowledged"
  ));

  // ---- SOR-48/SOR-18: lifecycle audit fields + Work title + explicit reason explanation ----

  results.push(check(
    "[SOR-48] acknowledgedAt/resolvedAtはAttentionItemViewからAttentionCardViewへそのまま透過する",
    toAttentionCardView(baseAttentionItem({ acknowledgedAt: "2026-09-24T01:00:00.000Z", resolvedAt: null })).acknowledgedAt === "2026-09-24T01:00:00.000Z" &&
      toAttentionCardView(baseAttentionItem({ acknowledgedAt: null, resolvedAt: "2026-09-24T02:00:00.000Z" })).resolvedAt === "2026-09-24T02:00:00.000Z"
  ));

  results.push(check(
    "[SOR-18] workTitleが確定している場合はそのままAttentionCardView.workTitleへ反映する",
    toAttentionCardView(baseAttentionItem({ workId: "W-001", workTitle: "Q3 renewal outreach" })).workTitle === "Q3 renewal outreach"
  ));

  results.push(check(
    "[SOR-18/No-Fabrication] workTitle=null(Work未読み込み/未割当)はnullのまま、workIdの有無に関わらず推測で埋めない",
    toAttentionCardView(baseAttentionItem({ workId: "W-002", workTitle: null })).workTitle === null
  ));

  results.push(check(
    "[SOR-18] attentionReasonExplanationは2つの現行reasonそれぞれに明示的なproduct-facing文を持つ(reasonCodeの機械的変換に頼らない)",
    toAttentionCardView(baseAttentionItem({ reason: "permission_mismatch" })).attentionReasonExplanation === "This action was not permitted by the current Permission Registry rules." &&
      toAttentionCardView(baseAttentionItem({ reason: "approval_required" })).attentionReasonExplanation === "This action requires human approval before it can proceed."
  ));

  // =========================
  // Screen 3: Work Detail — derived view (filteringはこのmoduleでは行わない)
  // =========================

  results.push(check(
    "[Required test] toWorkTimelineItemView はCanonicalExecutionをそのまま1件変換するだけで、workIdによるfilteringは行わない(呼び出し元がlistExecutionsForWork()で絞り込む前提)",
    (() => {
      const exec = baseExecution({ id: "exec-9", workId: "W-999" });
      const view = toWorkTimelineItemView(exec, undefined);
      return view.executionId === "exec-9" && !("workId" in view);
    })()
  ));

  // ---- SOR-23 (OBS-UX-P1 Priority 2 "why this Work"): correlation summary
  // is threaded through when the caller has one, and never fabricated
  // (undefined) when it doesn't. ----
  results.push(check(
    "[SOR-23] toWorkTimelineItemView with a correlation summary exposes methodLabel/confidence/reasonCode and derives isHumanCorrected from method",
    (() => {
      const exec = baseExecution({ id: "exec-10", workId: "W-001" });
      const view = toWorkTimelineItemView(exec, { method: "manual_override", confidence: null, reasonCode: "human_confirmed_candidate" });
      return view.correlationMethodLabel === "Manual correction" &&
        view.correlationConfidence === null &&
        view.correlationReasonCode === "human_confirmed_candidate" &&
        view.isHumanCorrected === true;
    })()
  ));

  results.push(check(
    "[SOR-23] toWorkTimelineItemView with an auto-matched summary carries isHumanCorrected=false",
    toWorkTimelineItemView(baseExecution({ id: "exec-11" }), { method: "structural", confidence: 0.9, reasonCode: "notion_resource_match" }).isHumanCorrected === false
  ));

  results.push(check(
    "[SOR-23/No-Fabrication] toWorkTimelineItemView with no correlation summary (undefined) never fabricates one — every correlation field stays null/false",
    (() => {
      const view = toWorkTimelineItemView(baseExecution({ id: "exec-12" }), undefined);
      return view.correlationMethodLabel === null && view.correlationConfidence === null &&
        view.correlationReasonCode === null && view.isHumanCorrected === false;
    })()
  ));

  results.push(check(
    "[SOR-119] toWorkTimelineItemView passes execution.outcomeStatus/outcomeKind through unchanged, never recomputing or guessing Outcome from execution status",
    (() => {
      const asserted = toWorkTimelineItemView(
        baseExecution({ id: "exec-outcome-1", status: "succeeded", outcomeStatus: "asserted", outcomeKind: "page_updated" }),
        undefined
      );
      const unknown = toWorkTimelineItemView(
        baseExecution({ id: "exec-outcome-2", status: "succeeded", outcomeStatus: "unknown", outcomeKind: null }),
        undefined
      );
      return asserted.outcomeStatus === "asserted" && asserted.outcomeKind === "page_updated" &&
        unknown.outcomeStatus === "unknown" && unknown.outcomeKind === null;
    })()
  ));

  results.push(check(
    "[SOR-23/Privacy] WorkTimelineItemView keys match the documented allow-list exactly (no raw payload/token ever flows through this boundary)",
    (() => {
      const view = toWorkTimelineItemView(baseExecution({ id: "exec-13" }), { method: "structural", confidence: 0.9, reasonCode: "notion_resource_match" });
      const actualKeys = Object.keys(view).sort();
      const expectedKeys = [...WORK_TIMELINE_ITEM_VIEW_KEYS].sort();
      return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
    })()
  ));

  results.push(check(
    "[Required test] WorkHeaderView: attentionCountを渡さない場合はnull(\"if easy\"の省略を許容する)",
    toWorkHeaderView(baseWork(), 3).attentionCount === null
  ));

  results.push(check(
    "[Required test] WorkHeaderView: attentionCountを渡した場合はそのまま反映する",
    toWorkHeaderView(baseWork(), 3, 1).attentionCount === 1
  ));

  results.push(check(
    "[Required test] WorkHeaderView.statusLabel は internal word \"running\" ではなく canonical wording \"Running\" を返す",
    toWorkHeaderView(baseWork({ status: "running" }), 0).statusLabel === "Running"
    && workStatusLabel("running") === "Running"
  ));

  results.push(check(
    "[Required test] Work.title=null -> WorkHeaderView.title=null(空文字へ変換しない、呼び出し側がworkIdへfallbackできるようにする)",
    toWorkHeaderView(baseWork({ title: null }), 0).title === null
  ));

  // =========================
  // Canonical wording: internal word(matched/denied/approval_required等)を
  // 一切そのまま出さない
  // =========================

  results.push(check(
    "[Required test] permissionResultLabel は internal word (\"allowed\"/\"denied\"等)を一切含まない",
    [permissionResultLabel("MATCH"), permissionResultLabel("MISMATCH"), permissionResultLabel("APPROVAL_REQUIRED"), permissionResultLabel("UNKNOWN")]
      .every((label) => !/allowed|denied|approval_required|unknown_internal/i.test(label))
  ));

  // =========================
  // Privacy: ActivityItemViewが許可されたkey以外を持たないこと
  // (raw payload / token / credential / error messageを含まない)
  // =========================

  results.push(check(
    "[Required test] ActivityItemView のkeyは許可listと完全一致する(raw error / token / credentialを含まない)",
    (() => {
      const view = toActivityItemView(baseExecution({ errorCode: "boom", errorMessage: "secret leaking detail", sourceMetadata: { token: "should-not-appear" } }), null, false);
      const actualKeys = Object.keys(view).sort();
      const expectedKeys = [...ACTIVITY_ITEM_VIEW_KEYS].sort();
      return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
    })()
  ));

  // =========================
  // Human comprehension test fixture (SOR-54指示、4行)
  // Sora / Claude Test Agent / Notion / <action> / <permission> / <result> / <work>
  // production codeへhardcodeせず、test fixtureとしてのみ再現する。
  // =========================

  const humanFixtureRow1 = toActivityItemView(baseExecution({
    id: "exec-h1",
    workId: "W-001",
    correlationStatus: "matched",
    operation: "notion_read",
    actionCategory: "read",
    permissionStatus: "allowed",
    status: "succeeded",
  }), null, false);

  results.push(check(
    "[Human comprehension fixture row1] Sora / Claude Test Agent / Notion / READ / MATCH / Succeeded / W-001",
    humanFixtureRow1.principalLabel === "Sora"
    && humanFixtureRow1.agentLabel === "Claude Test Agent"
    && humanFixtureRow1.targetSystem.label === "Notion"
    && humanFixtureRow1.action === "READ"
    && humanFixtureRow1.permissionEvaluation === "MATCH"
    && humanFixtureRow1.executionStatus === "succeeded"
    && humanFixtureRow1.workId === "W-001"
    && humanFixtureRow1.correlationStatus === "CORRELATED"
  ));

  const humanFixtureRow2 = toActivityItemView(baseExecution({
    id: "exec-h2",
    workId: "W-001",
    correlationStatus: "matched",
    operation: "notion_update_page",
    actionCategory: "update",
    permissionStatus: "approval_required",
    status: "succeeded",
  }), null, false);

  results.push(check(
    "[Human comprehension fixture row2] Sora / Claude Test Agent / Notion / UPDATE_PAGE / APPROVAL_REQUIRED / Succeeded / W-001",
    humanFixtureRow2.action === "UPDATE_PAGE"
    && humanFixtureRow2.permissionEvaluation === "APPROVAL_REQUIRED"
    && humanFixtureRow2.executionStatus === "succeeded"
    && humanFixtureRow2.workId === "W-001"
  ));

  const humanFixtureRow3 = toActivityItemView(baseExecution({
    id: "exec-h3",
    workId: null,
    correlationStatus: "unresolved",
    operation: "notion_delete_page",
    actionCategory: "delete",
    permissionStatus: "denied",
    status: "succeeded",
  }), null, false);

  results.push(check(
    "[Human comprehension fixture row3] Sora / Claude Test Agent / Notion / DELETE_PAGE / MISMATCH / Succeeded / Unassigned",
    humanFixtureRow3.action === "DELETE_PAGE"
    && humanFixtureRow3.permissionEvaluation === "MISMATCH"
    && humanFixtureRow3.executionStatus === "succeeded"
    && humanFixtureRow3.correlationStatus === "UNASSIGNED"
  ));

  const humanFixtureRow4 = toActivityItemView(baseExecution({
    id: "exec-h4",
    workId: null,
    correlationStatus: "unresolved",
    operation: "notion_read",
    actionCategory: "read",
    permissionStatus: "allowed",
    status: "failed",
  }), null, false);

  results.push(check(
    "[Human comprehension fixture row4] Sora / Claude Test Agent / Notion / READ / MATCH / Failed / Unassigned",
    humanFixtureRow4.action === "READ"
    && humanFixtureRow4.permissionEvaluation === "MATCH"
    && humanFixtureRow4.executionStatus === "failed"
    && humanFixtureRow4.correlationStatus === "UNASSIGNED"
  ));

  return summarize("TACT Runs UI — SOR-54 Read-Model Projections", results);
}
