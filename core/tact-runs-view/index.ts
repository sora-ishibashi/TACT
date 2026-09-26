// =========================
// TACT Runs — UI Read-Model Projection (SOR-54)
// =========================
//
// SOR-54指示「Core Principle」: UIは新しいsource of truthを作らない。
// このfileはDBアクセスを一切行わない、純粋な変換関数だけを持つ
// (Canonical Execution / Permission canonical mapping / Correlation
// canonical mapping / Attention read model、いずれも既存SOR-50〜53の
// 出力をそのまま読み、再計算・再判定は一切しない)。
//
// 「UI内にbusiness logicを持ち込まない」の実践: permission/attention
// eligibility/correlationの「判定」は一切ここに書かない。すでに
// 確定した値(execution.permissionStatus・execution.correlationStatus・
// AttentionItemView等)を、人間向けのlabel文字列へ変換するだけ。

// 絶対条件(重要、client component向け): 各moduleのbarrel index
// (core/tact-execution/permission、core/tact-execution/correlation等)
// からはimportしない——barrelは`export * from "./store"`等を含み、
// core/tact-work/store.ts(core/tact-orchestrator経由で@tavily/core等の
// server-only packageへ到達する重いchain)を無条件に引き込んでしまう
// (実際にnext buildで検出済み)。このfileはRunsSectionからclient
// componentへ直接importされるため、値としてimportする関数は必ず
// DBアクセスを持たないpure leaf file(canonicalResult.ts)から、型は
// type-onlyでimportする(type-onlyは常にeraseされ、参照元file自体の
// 重さに関係なくbundleへ影響しない)。
import { toCanonicalPermissionResult, type CanonicalPermissionResult } from "../tact-execution/permission/canonicalResult";
import { toCanonicalExecutionCorrelationStatus, toCanonicalCorrelationResult, type CanonicalCorrelationResult } from "../tact-execution/correlation/canonicalResult";
import type { AttentionReason } from "../tact-execution/permission/attention";
import type { AttentionItemView } from "../tact-execution/permission/attentionStore";
import type { WorkCorrelationMethod, WorkCorrelationDecision } from "../tact-execution/correlation/types";
import type { ExecutionCorrelationView, ExecutionCorrectionContext } from "../tact-execution/correlation/store";
import type {
  CanonicalExecution,
  ExecutionPermissionStatus,
  ExecutionProvider,
  ExecutionStatus,
} from "../tact-execution/types";
import type { Work, WorkStatus } from "../tact-work/types";

// =========================
// Shared label helpers
// =========================

const UNKNOWN_PRINCIPAL_LABEL = "Unknown principal";
const UNKNOWN_AGENT_LABEL = "Unknown agent";

// 絶対条件(SOR-54指示「Principal / Agent fallback」): 空欄にしない、
// ただし推測しない——既に持っているid文字列をそのまま出すか、
// 無ければ明示的な"Unknown"文言を出す(名前解決・表示名の別テーブルは
// M-0では存在しない)。
export function principalLabel(actorId: string | null): string {
  return actorId && actorId.trim().length > 0 ? actorId : UNKNOWN_PRINCIPAL_LABEL;
}

export function agentLabel(agentId: string | null): string {
  return agentId && agentId.trim().length > 0 ? agentId : UNKNOWN_AGENT_LABEL;
}

const PROVIDER_LABELS: Record<ExecutionProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  mcp: "MCP",
  slack: "Slack",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  notion: "Notion",
  microsoft365: "Microsoft 365",
  salesforce: "Salesforce",
  custom: "Custom",
};

export interface TargetSystemLabel {
  label: string;
  subLabel: string | null;
}

// 絶対条件(SOR-54指示「Provider / targetSystem」): 内部provider="mcp"
// だけを主表示にしない。ユーザーには実際の対象system(targetProvider、
// 無ければprovider自体)を主表示にし、MCP経由であることは補助的な
// sub-labelとしてのみ出す。
export function targetSystemLabel(provider: ExecutionProvider, targetProvider: ExecutionProvider | null): TargetSystemLabel {

  const system = targetProvider ?? provider;
  const label = PROVIDER_LABELS[system] ?? system;
  const subLabel = provider === "mcp" && targetProvider && targetProvider !== "mcp" ? "via MCP" : null;

  return { label, subLabel };

}

// operationは既存adapterが設定した内部識別子(例: "notion_update_page"、
// "app_mention")——ここでは意味を再解釈せず、対象systemの接頭辞を
// 機械的に取り除いて大文字化するだけ(例: "UPDATE_PAGE")。fixtureの
// 期待値(READ/CREATE_PAGE/UPDATE_PAGE/DELETE_PAGE)と一致する。
export function actionLabel(operation: string, provider: ExecutionProvider, targetProvider: ExecutionProvider | null): string {

  const system = targetProvider ?? provider;
  const prefix = `${system}_`;
  const withoutPrefix = operation.toLowerCase().startsWith(prefix) ? operation.slice(prefix.length) : operation;

  return withoutPrefix.toUpperCase();

}

const PERMISSION_LABELS: Record<CanonicalPermissionResult, string> = {
  MATCH: "Match",
  MISMATCH: "Mismatch",
  APPROVAL_REQUIRED: "Approval required",
  UNKNOWN: "Unknown",
};

export function permissionResultLabel(result: CanonicalPermissionResult): string {
  return PERMISSION_LABELS[result];
}

// ExecutionPermissionStatus(../tact-execution/types.ts、5値、"pending"を
// 含む)をcanonical語彙へ変換する。"pending"(未評価)はUNKNOWNとして
// 扱う——推測せず、確定していないという事実をそのまま表す。
export function toCanonicalPermissionResultFromExecutionStatus(status: ExecutionPermissionStatus): CanonicalPermissionResult {

  if (status === "pending") {
    return "UNKNOWN";
  }

  return toCanonicalPermissionResult(status);

}

const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  observed: "Observed",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

export function executionResultLabel(status: ExecutionStatus): string {
  return EXECUTION_STATUS_LABELS[status];
}

const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  approval_required: "Approval required",
  permission_mismatch: "Permission mismatch",
};

export function attentionReasonLabel(reason: AttentionReason): string {
  return ATTENTION_REASON_LABELS[reason];
}

// SOR-18(Human Owner指示「For "why" copy: prefer explicit product-facing
// text... Do not rely only on generic snake_case -> Title Case」):
// AttentionReasonは現時点で2値のみ(ATTENTION_REASONS参照)のため、
// 網羅的な明示copyをそのまま持つ——将来値が増えた場合はこのmapへ
// 1行足すだけでよい(reasonCodeの機械的な変換には頼らない)。
const ATTENTION_REASON_EXPLANATIONS: Record<AttentionReason, string> = {
  permission_mismatch: "This action was not permitted by the current Permission Registry rules.",
  approval_required: "This action requires human approval before it can proceed.",
};

export function attentionReasonExplanation(reason: AttentionReason): string {
  return ATTENTION_REASON_EXPLANATIONS[reason];
}

const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  created: "Created",
  planning: "Planning",
  running: "Running",
  waiting_for_input: "Waiting for input",
  waiting_for_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function workStatusLabel(status: WorkStatus): string {
  return WORK_STATUS_LABELS[status];
}

// SOR-77 (CORRELATION-REVIEW-P1): human-facing label for the internal
// WorkCorrelationMethod vocabulary (same "never show a raw snake_case
// internal word" rule as the other label maps in this file).
const WORK_CORRELATION_METHOD_LABELS: Record<WorkCorrelationMethod, string> = {
  explicit: "Explicit",
  structural: "Structural match",
  temporal_participant: "Recent activity",
  ai_assisted: "AI-assisted",
  manual_override: "Manual correction",
};

export function workCorrelationMethodLabel(method: WorkCorrelationMethod): string {
  return WORK_CORRELATION_METHOD_LABELS[method];
}

// =========================
// Screen 1: Activity
// =========================

export interface ActivityItemView {

  executionId: string;

  observedAt: string;

  principalLabel: string;

  agentLabel: string;

  targetSystem: TargetSystemLabel;

  action: string;

  permissionEvaluation: CanonicalPermissionResult;

  executionStatus: ExecutionStatus;

  workId: string | null;

  correlationStatus: CanonicalCorrelationResult;

  // SOR-77 live Staging verification defect(UX gap): tact_canonical_
  // executions自体には「人間が訂正したか」を表す列が無い(絶対条件、
  // do not add duplicate columns)——呼び出し元(API route)が
  // listLatestCorrelationMethodsForExecutions()で既存のappend-only
  // historyから導出し、ここへ渡す。CORRELATED行でReview/History導線を
  // 出すかどうかの唯一の判断材料(このfile自身は「出す/出さない」の
  // 判定をしない、値をそのまま運ぶだけ)。
  isHumanCorrected: boolean;

}

export function toActivityItemView(execution: CanonicalExecution, isHumanCorrected: boolean): ActivityItemView {

  return {
    executionId: execution.id,
    observedAt: execution.observedAt,
    principalLabel: principalLabel(execution.actorId),
    agentLabel: agentLabel(execution.agentId),
    targetSystem: targetSystemLabel(execution.provider, execution.targetProvider),
    action: actionLabel(execution.operation, execution.provider, execution.targetProvider),
    permissionEvaluation: toCanonicalPermissionResultFromExecutionStatus(execution.permissionStatus),
    executionStatus: execution.status,
    workId: execution.workId,
    correlationStatus: toCanonicalExecutionCorrelationStatus(execution.correlationStatus),
    isHumanCorrected,
  };

}

// =========================
// Screen 2: Needs Attention
// =========================

export interface AttentionCardView {

  attentionId: string;

  executionId: string;

  createdAt: string;

  principalLabel: string;

  agentLabel: string;

  targetSystem: TargetSystemLabel;

  action: string;

  attentionReason: AttentionReason;

  attentionReasonLabel: string;

  // SOR-18(Human Owner指示、"why" copy): reasonCodeの機械的な変換では
  // なく、2値限定の明示product-facing文。
  attentionReasonExplanation: string;

  permissionEvaluation: CanonicalPermissionResult;

  executionStatus: ExecutionStatus;

  // SOR-54指示section「Attention Work behavior」: SOR-52のread model
  // (AttentionItemView)はworkIdだけを持つ(ambiguous/unassignedの区別は
  // 持たない)——このcard自体も「Work / Unassigned」という指示どおりの
  // 二値表現に留める(独自にambiguousを判定・追加しない)。
  workId: string | null;

  // SOR-18(加算的field): workIdが確定している場合のみ非null
  // (tenant-safeな読み時joinの結果、attentionStore.ts参照)。
  workTitle: string | null;

  status: AttentionItemView["status"];

  // SOR-48(Attention Lifecycle、加算的field)。
  acknowledgedAt: string | null;

  resolvedAt: string | null;

}

export function toAttentionCardView(item: AttentionItemView): AttentionCardView {

  return {
    attentionId: item.attentionId,
    executionId: item.executionId,
    createdAt: item.createdAt,
    principalLabel: principalLabel(item.actor.id),
    agentLabel: agentLabel(item.agentId),
    targetSystem: targetSystemLabel(item.provider, item.targetProvider),
    action: actionLabel(item.action.operation, item.provider, item.targetProvider),
    attentionReason: item.reason,
    attentionReasonLabel: attentionReasonLabel(item.reason),
    attentionReasonExplanation: attentionReasonExplanation(item.reason),
    permissionEvaluation: toCanonicalPermissionResult(item.permissionEvaluation.status),
    executionStatus: item.executionStatus,
    workId: item.workId,
    workTitle: item.workTitle,
    status: item.status,
    acknowledgedAt: item.acknowledgedAt,
    resolvedAt: item.resolvedAt,
  };

}

// =========================
// Screen 3: Work Detail
// =========================

export interface WorkTimelineItemView {

  executionId: string;

  observedAt: string;

  principalLabel: string;

  agentLabel: string;

  targetSystem: TargetSystemLabel;

  action: string;

  permissionEvaluation: CanonicalPermissionResult;

  executionStatus: ExecutionStatus;

}

// 絶対条件(SOR-53指示「別のTimeline ledgerを作らない」の帰結、SOR-54
// 指示「Important architecture rule」): 呼び出し元がlistExecutionsForWork()
// (既存、SOR-50)で絞り込んだExecution配列をそのまま渡す前提——この
// 関数自身はfilteringを一切行わない(Canonical Execution Ledgerを
// filter by workIdした結果をderived viewへ変換するだけ)。
export function toWorkTimelineItemView(execution: CanonicalExecution): WorkTimelineItemView {

  return {
    executionId: execution.id,
    observedAt: execution.observedAt,
    principalLabel: principalLabel(execution.actorId),
    agentLabel: agentLabel(execution.agentId),
    targetSystem: targetSystemLabel(execution.provider, execution.targetProvider),
    action: actionLabel(execution.operation, execution.provider, execution.targetProvider),
    permissionEvaluation: toCanonicalPermissionResultFromExecutionStatus(execution.permissionStatus),
    executionStatus: execution.status,
  };

}

export interface WorkHeaderView {

  workId: string;

  title: string | null;

  status: WorkStatus;

  statusLabel: string;

  executionCount: number;

  // "if easy"(SOR-54指示)。計算コストが低い場合のみ埋める——呼び出し元
  // (API route)が省略した場合はnull。
  attentionCount: number | null;

}

export function toWorkHeaderView(
  work: Pick<Work, "id" | "title" | "status">,
  executionCount: number,
  attentionCount: number | null = null
): WorkHeaderView {

  return {
    workId: work.id,
    title: work.title ?? null,
    status: work.status,
    statusLabel: workStatusLabel(work.status),
    executionCount,
    attentionCount,
  };

}

// =========================
// Screen 4: Correlation Review (SOR-77 CORRELATION-REVIEW-P1)
// =========================
//
// 絶対条件(SOR-77指示「No business logic in React」の延長): 「候補を
// どう見せるか」の組み立てだけをここで行う——「どのWorkが候補か」
// (correlateExecution())・「correctionをどう永続化するか」
// (persistManualWorkCorrelationOverride())のいずれの判定もここには
// 無い。呼び出し元(API route)がgetExecutionCorrelationView()・
// getExecutionCorrectionContext()・listWorkTitlesByIds()(すべて既存/
// SOR-77で追加した読み取り専用関数)から集めた生データを、この関数へ
// そのまま渡すだけ。

// SOR-77 live Staging verification defect: a candidateWorkId persisted in
// correlation history is a historical fact ("this Work was a candidate at
// the time"), not a live guarantee that the Work is still assignable today.
// Reviewed live against real Staging: two historical candidates whose Work
// rows had since been deleted (fixture drift in scripts/dev/runsSeed.ts's
// clean mode, unrelated to production code) still rendered an active
// Confirm button, which then failed server-side with target_work_not_found
// — correct rejection, but a broken/confusing UX, and the underlying gap
// (no actionability re-check at read time) would recur for any real,
// non-fixture Work that gets deleted or reaches a terminal status between
// when a decision was recorded and when a human reviews it.
export interface SuggestedWorkCandidateView {

  workId: string;

  // tenant-safe読み時join(listWorkTitlesByIds())の結果。Workが読めない
  // (他tenant・削除済み等)場合はnull(No-Fabrication、workId自体は
  // そのまま残す)。
  title: string | null;

  // Re-validated at read time against the Work's CURRENT tenant/state
  // (core/tact-execution/store.tsのresolveTargetWorkForCorrelation()、
  // captureExecution()/reclassify_execution_work()と全く同じ判定を再利用
  // ——新しい判定ロジックをここで発明しない)。false の場合、この候補は
  // 履歴上の事実としては保持されるが(historyを書き換えない、
  // candidateWorkIds自体は削らない)、Confirmは提示しない。
  actionable: boolean;

  // actionable===falseの場合のみ意味を持つ。他tenantの存在有無を漏らさ
  // ない既存規約(resolveTargetWorkForCorrelation()のnot_found)のため、
  // "not_found"は「存在しない」と「他tenant」を区別しない——ここでも
  // 区別を復元しない。
  unavailableReason: "not_found" | "not_correlatable" | null;

}

export interface CorrectionTrailEntryView {

  finalWorkId: string | null;

  previousWorkId: string | null;

  reasonCode: string;

  changedByActorKind: string | null;

  changedByActorId: string | null;

  correlatedAt: string;

}

// SOR-77 live Staging verification UX gap (reopen requirement "correction
// history"/"human correction trail"): every decision ever recorded for
// this Execution, oldest→newest not required — the source array
// (ExecutionCorrectionContext.history) is already newest-first. This is a
// read-only projection of WorkCorrelationDecision; it never rewrites or
// re-derives history (絶対条件、append-only historyは書き換えない).
export interface CorrelationHistoryEntryView {

  methodLabel: string;

  canonicalStatus: CanonicalCorrelationResult;

  workId: string | null;

  confidence: number | null;

  reasonCode: string;

  // manual_override以外は常にnull(自動stageに"actor"は無い)。
  changedByActorKind: string | null;

  changedByActorId: string | null;

  correlatedAt: string;

}

export interface CorrelationReviewView {

  executionId: string;

  currentWorkId: string | null;

  // SOR-77 live Staging verification UX gap fix (reopen requirement
  // "current Work"): tenant-safe読み時join(listWorkTitlesByIds())の結果、
  // currentWorkId===nullの場合は常にnull。
  currentWorkTitle: string | null;

  currentStatus: CanonicalCorrelationResult;

  // 直近のstage決定(訂正が無ければ現在のstatusと同じ根拠)。
  confidence: number | null;

  reasonCode: string | null;

  methodLabel: string | null;

  // SOR-77 UX target「suggested Work candidates」。空配列はcandidateが
  // 無かったことを示す(候補が1件も無いUNASSIGNEDと、候補はあるが
  // 複数で絞れないAMBIGUOUSを、この配列の長さで区別できる——推測で
  // 埋めない)。
  candidates: SuggestedWorkCandidateView[];

  // true = 直近decisionがmanual_override(人間が既に訂正済み)。
  // 絶対条件(SOR-77「Keep Unassigned must be a first-class human
  // decision, not absence of data」): currentWorkId===nullだけでは
  // 「まだ判定できていない」のか「人間が明示的にUnassignedのままにした」
  // のかを区別できない——isHumanCorrectedとcorrectionが、その区別を
  // 常に明示的に表す。
  isHumanCorrected: boolean;

  // isHumanCorrected===trueの場合のみ非null。
  correction: CorrectionTrailEntryView | null;

  // SOR-77 live Staging verification UX gap fix: reopen時に見せる
  // 「prior system prediction / human correction trail」の完全な履歴
  // (newest first)。correctionが1件のみの要約なのに対し、こちらは
  // 複数回の訂正・複数回の自動再評価もすべて含む(append-only history
  // をそのまま射影するだけ、書き換えない)。
  history: CorrelationHistoryEntryView[];

}

export interface WorkActionabilityEntry {

  actionable: boolean;

  unavailableReason: "not_found" | "not_correlatable" | null;

}

function toCorrelationHistoryEntryView(decision: WorkCorrelationDecision): CorrelationHistoryEntryView {

  return {
    methodLabel: workCorrelationMethodLabel(decision.method),
    canonicalStatus: toCanonicalCorrelationResult(decision.status),
    workId: decision.workId,
    confidence: decision.confidence,
    reasonCode: decision.reasonCode,
    changedByActorKind: decision.changedByActorKind ?? null,
    changedByActorId: decision.changedByActorId ?? null,
    correlatedAt: decision.correlatedAt,
  };

}

export function toCorrelationReviewView(
  correlation: ExecutionCorrelationView,
  context: ExecutionCorrectionContext,
  workTitles: ReadonlyMap<string, string | null>,
  workActionability: ReadonlyMap<string, WorkActionabilityEntry>
): CorrelationReviewView {

  const isHumanCorrected = context.correction !== null;

  // 絶対条件(重要): 訂正済みの場合、confidence/reasonCode/method/
  // candidatesは「訂正の根拠になった直前の自動decision」
  // (context.predicted)から取る——manual_overrideのdecision自体は
  // candidateWorkIds/confidenceを常に持たない(reclassify_execution_work()
  // RPCの設計、SOR-52)ため、correlation側(=最新decision)の値を
  // そのまま使うと「何が予測されていたか」が失われ、Activity/Audit
  // trailからpredicted evidenceが消えてしまう(SOR-77指示「Activity/
  // Audit must still expose the prior prediction/correction trail」)。
  const basis = isHumanCorrected
    ? context.predicted
    : {
        confidence: correlation.confidence,
        reasonCode: correlation.reasonCode,
        method: correlation.method,
        candidateWorkIds: correlation.candidateWorkIds,
      };

  // 絶対条件(Never Guess Rule、fail closed): actionabilityがこのmapに
  // 無いcandidate(呼び出し元が再検証を怠った/対象外にした場合)は、
  // actionable=falseとして扱う——「確認していない」を「使える」に
  // 倒さない。
  const candidates: SuggestedWorkCandidateView[] = (basis?.candidateWorkIds ?? []).map((workId) => {

    const actionability = workActionability.get(workId);

    return {
      workId,
      title: workTitles.get(workId) ?? null,
      actionable: actionability?.actionable ?? false,
      unavailableReason: actionability?.actionable ? null : actionability?.unavailableReason ?? "not_found",
    };

  });

  return {
    executionId: correlation.executionId,
    currentWorkId: correlation.workId,
    currentWorkTitle: correlation.workId ? workTitles.get(correlation.workId) ?? null : null,
    currentStatus: correlation.correlationStatus,
    confidence: basis?.confidence ?? null,
    reasonCode: basis?.reasonCode ?? null,
    methodLabel: basis?.method ? workCorrelationMethodLabel(basis.method) : null,
    candidates,
    isHumanCorrected,
    correction: context.correction
      ? {
          finalWorkId: context.correction.finalWorkId,
          previousWorkId: context.correction.previousWorkId,
          reasonCode: context.correction.reasonCode,
          changedByActorKind: context.correction.changedByActorKind,
          changedByActorId: context.correction.changedByActorId,
          correlatedAt: context.correction.correlatedAt,
        }
      : null,
    history: context.history.map(toCorrelationHistoryEntryView),
  };

}

// =========================
// Privacy guard (SOR-54指示「Privacy」、テスト容易性のために公開する)
// =========================
//
// UI read modelが実際にaccept/renderするfield名の許可list。テスト側が
// 「render対象のオブジェクトにこれ以外のkeyが無い」ことを検証できる
// ようにするための、ドキュメント目的の定数(実行時のfilteringではない
// ——上記各toXView()関数自体が、そもそもraw payload/token/credentialを
// 一切受け取らない引数shapeになっていることが一次の保証)。
export const ACTIVITY_ITEM_VIEW_KEYS: readonly (keyof ActivityItemView)[] = [
  "executionId", "observedAt", "principalLabel", "agentLabel", "targetSystem",
  "action", "permissionEvaluation", "executionStatus", "workId", "correlationStatus",
  "isHumanCorrected",
];

export const CORRELATION_REVIEW_VIEW_KEYS: readonly (keyof CorrelationReviewView)[] = [
  "executionId", "currentWorkId", "currentWorkTitle", "currentStatus", "confidence", "reasonCode",
  "methodLabel", "candidates", "isHumanCorrected", "correction", "history",
];

export const SUGGESTED_WORK_CANDIDATE_VIEW_KEYS: readonly (keyof SuggestedWorkCandidateView)[] = [
  "workId", "title", "actionable", "unavailableReason",
];

export const CORRELATION_HISTORY_ENTRY_VIEW_KEYS: readonly (keyof CorrelationHistoryEntryView)[] = [
  "methodLabel", "canonicalStatus", "workId", "confidence", "reasonCode",
  "changedByActorKind", "changedByActorId", "correlatedAt",
];

export type { AttentionReason, CanonicalPermissionResult, CanonicalCorrelationResult };
