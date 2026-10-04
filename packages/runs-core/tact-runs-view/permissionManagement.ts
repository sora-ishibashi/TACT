// =========================
// TACT Runs — Permission Management Read Projection (SOR-187)
// =========================
//
// Pure, DB-free transform (same discipline as index.ts/attentionInbox.ts/
// governanceApprovalInbox.ts in this directory): no re-judging of
// permission/downstream comparison results, no DB access. This file reads
// three already-separate facts (Permission Registry Rule, Canonical
// Execution, Downstream Permission Evidence) and groups them under an
// AI x Service scope for display — it never merges them into one state.
//
// Absolute conditions carried over from the sources this projects (do not
// re-derive, only read):
//   - SOR-177 compareDownstreamPermissionEvidence(): evidence absence is
//     never "denied" (downstreamPermissionUnknown), CONFLICT is only ever
//     set from that function's own relationToRuns classification, and the
//     caller (this file) must pick exactly one PermissionDecision per
//     execution explicitly — it never averages/merges multiple decisions.
//   - SOR-47 Registry: rule.decision is a closed 3-value vocabulary
//     (allowed/denied/approval_required) distinct from the Execution's own
//     5-value ExecutionPermissionStatus and from CanonicalPermissionResult
//     (MATCH/MISMATCH/APPROVAL_REQUIRED/UNKNOWN) used elsewhere in Runs —
//     this file keeps the three vocabularies separate rather than
//     collapsing them into one shared label set.
//
// Scope key (AI x Service): a rule's own service scope is
// targetProvider ?? provider (identical fallback already used by this
// package's targetSystemLabel() for display — see index.ts), never
// invented here. The same fallback is used to bucket Executions for
// grouping/display only; it is NOT fed into compareDownstreamPermissionEvidence(),
// whose own assessApplicability() in downstreamPermission/compare.ts
// independently enforces "do not backfill execution.targetProvider from
// execution.provider" for the evidence-matching question. Those are two
// different questions (how to label/group a row for navigation vs. whether
// a specific evidence row legitimately applies to a specific execution).

import type {
  CanonicalExecution,
  ExecutionActionCategory,
  ExecutionProvider,
  ExecutionStatus,
} from "../tact-execution/types";
import type {
  PermissionDecision,
  PermissionRegistryRule,
} from "../tact-execution/permission/types";
import type {
  DownstreamEvidenceAuthorityLevel,
  DownstreamEvidenceTrustLevel,
  DownstreamPermissionEvidence,
  DownstreamPermissionState,
} from "../tact-execution/downstreamPermission/types";
import {
  compareDownstreamPermissionEvidence,
  type DownstreamEvidenceRelationToRuns,
} from "../tact-execution/downstreamPermission/compare";
import {
  targetSystemLabel,
  actionLabel,
  principalLabel,
  toCanonicalPermissionResultFromExecutionStatus,
  type CanonicalPermissionResult,
  type TargetSystemLabel,
} from "./index";

const UNSPECIFIED_AGENT_LABEL = "AI未指定";
const UNSPECIFIED_SERVICE_LABEL = "サービス未指定";

// =========================
// Japanese label helpers (new vocabulary specific to this screen — kept
// local rather than overloading the existing CanonicalPermissionResult /
// AttentionReason label sets in attentionInbox.ts, which use different
// wording for a different audience/question).
// =========================

export function permissionRuleDecisionJapanese(decision: PermissionRegistryRule["decision"]): string {
  switch (decision) {
    case "allowed": return "許可";
    case "approval_required": return "承認が必要";
    case "denied": return "許可しない";
  }
}

export function downstreamPermissionStateJapanese(state: DownstreamPermissionState): string {
  switch (state) {
    case "allowed": return "許可";
    case "denied": return "不許可";
    case "unknown": return "不明";
  }
}

export function downstreamAuthorityLevelJapanese(level: DownstreamEvidenceAuthorityLevel): string {
  switch (level) {
    case "AUTHORITATIVE": return "正本";
    case "NON_AUTHORITATIVE": return "参考";
    case "UNKNOWN": return "権限を確認できません";
  }
}

export function downstreamTrustLevelJapanese(level: DownstreamEvidenceTrustLevel): string {
  switch (level) {
    case "UNTRUSTED": return "未検証";
    case "AUTHENTICATED": return "認証済み";
    case "INTERNAL": return "内部";
  }
}

// 日本語例(SOR-187指示、絶対条件): この5値のみ。推測で追加しない。
export function downstreamRelationToRunsJapanese(relation: DownstreamEvidenceRelationToRuns): string {
  switch (relation) {
    case "CONSISTENT": return "一致";
    case "CONFLICT": return "接続先との衝突";
    case "UNKNOWN": return "判定できません";
    case "NOT_COMPARABLE": return "比較できません";
    case "NOT_APPLICABLE": return "対象外";
  }
}

// =========================
// Scope key
// =========================

function ruleServiceScope(rule: PermissionRegistryRule): ExecutionProvider | null {
  return rule.targetProvider ?? rule.provider;
}

// display/grouping only — never fed into compareDownstreamPermissionEvidence().
function executionServiceScope(execution: CanonicalExecution): ExecutionProvider | null {
  return execution.targetProvider ?? execution.provider;
}

function serviceDisplayLabel(service: ExecutionProvider | null): string {
  return service !== null ? targetSystemLabel(service, null, null).label : UNSPECIFIED_SERVICE_LABEL;
}

function agentDisplayLabel(agentId: string | null): string {
  return agentId && agentId.trim().length > 0 ? agentId : UNSPECIFIED_AGENT_LABEL;
}

function scopeKeyOf(agentId: string | null, service: ExecutionProvider | null): string {
  return `${agentId ?? "\u0000"}::${service ?? "\u0000"}`;
}

// =========================
// Per-row views
// =========================

export interface PermissionRegisteredRuleView {
  id: string;
  identifier: string;
  revision: number;
  agentId: string | null;
  agentDisplayLabel: string;
  provider: ExecutionProvider | null;
  targetProvider: ExecutionProvider | null;
  serviceDisplayLabel: string;
  actionCategory: ExecutionActionCategory | null;
  resourceType: string | null;
  decision: PermissionRegistryRule["decision"];
  decisionLabel: string;
  enabled: boolean;
  connectionId: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

function toPermissionRegisteredRuleView(rule: PermissionRegistryRule): PermissionRegisteredRuleView {
  const service = ruleServiceScope(rule);
  return {
    id: rule.id,
    identifier: rule.identifier,
    revision: rule.revision,
    agentId: rule.agentId,
    agentDisplayLabel: agentDisplayLabel(rule.agentId),
    provider: rule.provider,
    targetProvider: rule.targetProvider,
    serviceDisplayLabel: serviceDisplayLabel(service),
    actionCategory: rule.actionCategory,
    resourceType: rule.resourceType,
    decision: rule.decision,
    decisionLabel: permissionRuleDecisionJapanese(rule.decision),
    enabled: rule.enabled,
    connectionId: rule.connectionId,
    validFrom: rule.validFrom,
    validUntil: rule.validUntil,
  };
}

export interface PermissionDownstreamEvidenceView {
  evidenceId: string;
  executionId: string;
  provider: ExecutionProvider;
  permissionState: DownstreamPermissionState;
  permissionStateLabel: string;
  authorityLevel: DownstreamEvidenceAuthorityLevel;
  authorityLevelLabel: string;
  trustLevel: DownstreamEvidenceTrustLevel;
  trustLevelLabel: string;
  observedAt: string;
  relationToRuns: DownstreamEvidenceRelationToRuns;
  relationToRunsLabel: string;
}

export interface PermissionActualActionView {
  executionId: string;
  action: string;
  targetSystem: TargetSystemLabel;
  agentDisplayLabel: string;
  principalLabel: string;
  executionStatus: ExecutionStatus;
  permissionEvaluation: CanonicalPermissionResult;
  observedAt: string;
  workId: string | null;
}

export interface PermissionScopeView {
  scopeKey: string;
  agentId: string | null;
  agentDisplayLabel: string;
  serviceScope: ExecutionProvider | null;
  serviceDisplayLabel: string;
  registeredRules: PermissionRegisteredRuleView[];
  downstreamEvidence: PermissionDownstreamEvidenceView[];
  actualActions: PermissionActualActionView[];
  // SOR-177絶対条件を保持したまま導出: evidenceComparisons全体のうち
  // relationToRuns==="CONFLICT"が1件でもあるかどうか(推測・丸め無し)。
  hasConflict: boolean;
}

// =========================
// Build
// =========================

export interface BuildPermissionManagementScopesInput {
  rules: readonly PermissionRegistryRule[];
  executions: readonly CanonicalExecution[];
  // 絶対条件(SOR-187指示「比較用に最新decisionを明示的に選択する場合は
  // 『最新の記録済みRuns判定』として扱うこと」): 呼び出し元がexecutionId
  // ごとに保持しているdecision履歴全体(DESC順)をそのまま渡す。この関数
  // 自身がlatest-winsで履歴を書き換えたように見せることはしない——ここで
  // 選ぶのは比較に使う1件だけで、historyはどの画面にも渡していない。
  decisionsByExecutionId: ReadonlyMap<string, readonly PermissionDecision[]>;
  evidenceByExecutionId: ReadonlyMap<string, readonly DownstreamPermissionEvidence[]>;
}

// 「最新の記録済みRuns判定」を明示的に選ぶ(SOR-187指示)。呼び出し元の
// 配列順(DESC)に暗黙に依存しない——evaluatedAtで自分で確認する。
function selectLatestRecordedPermissionDecision(
  decisions: readonly PermissionDecision[]
): PermissionDecision | null {
  let latest: PermissionDecision | null = null;
  for (const decision of decisions) {
    if (latest === null || Date.parse(decision.evaluatedAt) > Date.parse(latest.evaluatedAt)) {
      latest = decision;
    }
  }
  return latest;
}

export function buildPermissionManagementScopes(
  input: BuildPermissionManagementScopesInput
): PermissionScopeView[] {

  const scopeKeys = new Map<string, { agentId: string | null; service: ExecutionProvider | null }>();

  for (const rule of input.rules) {
    const service = ruleServiceScope(rule);
    scopeKeys.set(scopeKeyOf(rule.agentId, service), { agentId: rule.agentId, service });
  }

  for (const execution of input.executions) {
    const service = executionServiceScope(execution);
    scopeKeys.set(scopeKeyOf(execution.agentId, service), { agentId: execution.agentId, service });
  }

  const scopes: PermissionScopeView[] = [];

  for (const [scopeKey, { agentId, service }] of scopeKeys) {

    const registeredRules = input.rules
      .filter((rule) => scopeKeyOf(rule.agentId, ruleServiceScope(rule)) === scopeKey)
      .map(toPermissionRegisteredRuleView);

    const scopedExecutions = input.executions.filter(
      (execution) => scopeKeyOf(execution.agentId, executionServiceScope(execution)) === scopeKey
    );

    const downstreamEvidence: PermissionDownstreamEvidenceView[] = [];
    let hasConflict = false;

    const actualActions: PermissionActualActionView[] = scopedExecutions.map((execution) => {

      const decisions = input.decisionsByExecutionId.get(execution.id) ?? [];
      const evidence = input.evidenceByExecutionId.get(execution.id) ?? [];
      const registeredPermissionResult = selectLatestRecordedPermissionDecision(decisions);

      const comparison = compareDownstreamPermissionEvidence({
        execution,
        registeredPermissionResult,
        downstreamEvidence: evidence,
      });

      if (comparison.downstreamPermissionConflict) {
        hasConflict = true;
      }

      // compare.tsの絶対条件(全行を個別に比較、並べ替え/重複排除しない)
      // により、evidenceComparisonsはevidence配列と同じ順序・同じ件数で
      // 返る——indexで元のtargetProvider(表示に必要)を取り出せる。
      comparison.evidenceComparisons.forEach((row, index) => {
        const sourceEvidence = evidence[index];
        downstreamEvidence.push({
          evidenceId: row.evidenceId,
          executionId: execution.id,
          provider: sourceEvidence.targetProvider,
          permissionState: row.permissionState,
          permissionStateLabel: downstreamPermissionStateJapanese(row.permissionState),
          authorityLevel: row.authorityLevel,
          authorityLevelLabel: downstreamAuthorityLevelJapanese(row.authorityLevel),
          trustLevel: row.trustLevel,
          trustLevelLabel: downstreamTrustLevelJapanese(row.trustLevel),
          observedAt: row.observedAt,
          relationToRuns: row.relationToRuns,
          relationToRunsLabel: downstreamRelationToRunsJapanese(row.relationToRuns),
        });
      });

      return {
        executionId: execution.id,
        action: actionLabel(execution.operation, execution.provider, execution.targetProvider),
        targetSystem: targetSystemLabel(execution.provider, execution.targetProvider, execution.adapterVersion),
        agentDisplayLabel: agentDisplayLabel(execution.agentId),
        principalLabel: principalLabel(execution.actorId),
        executionStatus: execution.status,
        permissionEvaluation: toCanonicalPermissionResultFromExecutionStatus(execution.permissionStatus),
        observedAt: execution.observedAt,
        workId: execution.workId,
      };

    });

    scopes.push({
      scopeKey,
      agentId,
      agentDisplayLabel: agentDisplayLabel(agentId),
      serviceScope: service,
      serviceDisplayLabel: serviceDisplayLabel(service),
      registeredRules,
      downstreamEvidence,
      actualActions,
      hasConflict,
    });

  }

  return scopes.sort((a, b) =>
    a.agentDisplayLabel.localeCompare(b.agentDisplayLabel) ||
    a.serviceDisplayLabel.localeCompare(b.serviceDisplayLabel)
  );

}

// =========================
// Sidebar filter helpers (SOR-23 distinctActivityFilterOptions/
// filterActivityItemsと同じ精神: filter判定・選択肢導出はReact側に置かず、
// ここへ集約する「No business logic in React」の実践)。
// =========================

export interface PermissionScopeAgentFilterOption {
  agentId: string | null;
  label: string;
  count: number;
}

export interface PermissionScopeServiceFilterOption {
  service: ExecutionProvider | null;
  label: string;
  count: number;
}

// 絶対条件(SOR-187指示「fake count禁止」): 実際に読み込まれたscopes配列
// から機械的に数えるだけ——推測・固定値は一切使わない。
export function summarizePermissionScopesByAgent(
  scopes: readonly PermissionScopeView[]
): PermissionScopeAgentFilterOption[] {
  const counts = new Map<string, { agentId: string | null; label: string; count: number }>();
  for (const scope of scopes) {
    const key = scope.agentId ?? "\u0000";
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { agentId: scope.agentId, label: scope.agentDisplayLabel, count: 1 });
    }
  }
  return [...counts.values()];
}

export function summarizePermissionScopesByService(
  scopes: readonly PermissionScopeView[]
): PermissionScopeServiceFilterOption[] {
  const counts = new Map<string, { service: ExecutionProvider | null; label: string; count: number }>();
  for (const scope of scopes) {
    const key = scope.serviceScope ?? "\u0000";
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { service: scope.serviceScope, label: scope.serviceDisplayLabel, count: 1 });
    }
  }
  return [...counts.values()];
}

export interface PermissionScopeFilters {
  search?: string;
  agentId?: string | null;
  service?: ExecutionProvider | null;
  needsConfirmationOnly?: boolean;
}

export function filterPermissionScopes(
  scopes: readonly PermissionScopeView[],
  filters: PermissionScopeFilters
): PermissionScopeView[] {

  const search = filters.search?.trim().toLocaleLowerCase();

  return scopes.filter((scope) => {

    if (filters.agentId !== undefined && scope.agentId !== filters.agentId) return false;
    if (filters.service !== undefined && scope.serviceScope !== filters.service) return false;
    if (filters.needsConfirmationOnly && !scope.hasConflict) return false;

    if (search) {
      const haystack = `${scope.agentDisplayLabel} ${scope.serviceDisplayLabel}`.toLocaleLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;

  });

}
