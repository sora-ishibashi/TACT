// =========================
// TACT Runs — Observed AI Management Projection (SOR-186)
// =========================
//
// Pure, DB-free transform (same discipline as permissionManagement.ts /
// coverageManagement.ts in this directory): no DB access, no re-judging of
// already-confirmed facts. This file only groups/labels data the caller
// already read from existing, established read boundaries
// (listExecutionsForUser/listOwnedPermissionRules/listExecutionAttentions/
// listWorkTitlesByIdsViaRegistry/postgresConnectionProjectionRepository).
//
// Repository Reality (SOR-186 instructions, absolute condition): there is
// no provider-neutral AI Identity Registry in Runs today. The only
// canonical identifier available is CanonicalExecution.agentId. This file
// MUST NOT invent, infer, or fabricate:
//   - a human-readable AI display name (agentId itself is the only label —
//     no brand-name pattern-matching on the id string, e.g. agentId
//     containing "claude" is never turned into a "Claude"/"Anthropic"
//     label)
//   - an AI vendor/provider ("AI provider" is a different concept from
//     CanonicalExecution.provider/targetProvider, which name the
//     observed/target SYSTEM — Notion/Slack/Gmail/MCP/etc — never an AI
//     vendor; aiProvider is always null)
//   - a model name (always null)
//   - a registration/enabled/live status (registrationStatus is always the
//     single literal "unknown" — SOR-213 is the only future owner of a real
//     registry; this file never reports "registered" just because an
//     Execution or Permission Rule references the agentId — referencing is
//     not registering)
//
// root core/tact-agent/agentRegistry.ts (Yolna's own in-memory Claude
// Code/Codex developer-orchestrator registry) is NEVER imported or
// projected here — it is not a source for this screen (SOR-186 instructions
// "絶対に使わない正本"). This file has no import of it, and none of its
// exports touch anything under core/tact-agent/.
//
// Inventory key (SOR-186 instructions "今回のAI Inventoryの意味"): the
// union of every NON-EMPTY (after trim) agentId appearing on a Canonical
// Execution AND/OR an owned Permission Registry Rule for this user. A
// Permission Rule referencing an agentId is evidence that identifier is
// USED AS A PERMISSION SCOPE — it is not evidence that an AI is
// "registered" (SOR-186 instructions "重要: Permission RuleにagentIdが
// ある != AIが登録済み").
//
// Bundling discipline (same as index.ts/permissionManagement.ts/
// coverageManagement.ts): only type-only imports from leaf files under
// ../tact-execution/** (never the heavy ../tact-execution barrel, which
// pulls in core/tact-work's server-only dependency chain) — this file is
// imported directly by RunsSection, a client component.

import type {
  CanonicalExecution,
  ExecutionActorKind,
  ExecutionProvider,
  ExecutionStatus,
} from "../tact-execution/types";
import type { PermissionRegistryRule } from "../tact-execution/permission/types";
import type { AttentionItemView } from "../tact-execution/permission/attentionStore";
import type { AttentionReason } from "../tact-execution/permission/attention";
import {
  targetSystemLabel,
  actionLabel,
  attentionReasonLabel,
  toCanonicalPermissionResultFromExecutionStatus,
  type CanonicalPermissionResult,
  type TargetSystemLabel,
} from "./index";
import {
  connectionStatusJapanese,
  type ConnectionReadState,
  type PublicConnection,
} from "./coverageManagement";

const UNCONFIRMED_LABEL = "確認できません";

// =========================
// Identity / inventory
// =========================

export type AgentIdentityEvidence = "execution_observed" | "permission_scoped";

// SOR-186 absolute condition: the ONLY value this can ever hold today.
// A real registration concept (registered/disabled/unregistered) is
// SOR-213's responsibility, not derivable from Execution/Permission Rule
// references.
export type AgentRegistrationStatus = "unknown";

function normalizeAgentId(agentId: string | null): string | null {
  if (agentId === null) return null;
  const trimmed = agentId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function executionsForAgent(executions: readonly CanonicalExecution[], agentId: string): CanonicalExecution[] {
  return executions.filter((execution) => normalizeAgentId(execution.agentId) === agentId);
}

function rulesForAgent(rules: readonly PermissionRegistryRule[], agentId: string): PermissionRegistryRule[] {
  return rules.filter((rule) => normalizeAgentId(rule.agentId) === agentId);
}

function attentionsForAgent(attentions: readonly AttentionItemView[], agentId: string): AttentionItemView[] {
  return attentions.filter((item) => normalizeAgentId(item.agentId) === agentId);
}

// =========================
// Target system grouping (section 4 / list summary) — reuses
// targetSystemLabel() exactly as computed (provider/targetProvider/
// adapterVersion, including the existing GitHub custom-adapter override),
// never a simplified 2-arg call that would silently drop that override.
// Distinct by the rendered label alone — same dedup unit as index.ts's own
// distinctActivityFilterOptions() (`providerLabels: [...new Set(items.map(
// (item) => item.targetSystem.label))]`), NOT label+subLabel. subLabel
// ("via MCP") describes the observation PATH, not a different target
// system — the same real system (e.g. Notion) observed once via MCP and
// once directly must still collapse into one entry here. The group's own
// subLabel is kept only as the first-seen execution's value (informational
// display only, not part of the dedup identity).
// =========================

export interface AgentTargetSystemView {
  label: string;
  subLabel: string | null;
  executionCount: number;
  lastObservedAt: string;
}

function buildTargetSystems(executions: readonly CanonicalExecution[]): AgentTargetSystemView[] {

  const byLabel = new Map<string, AgentTargetSystemView>();

  for (const execution of executions) {

    const system = targetSystemLabel(execution.provider, execution.targetProvider, execution.adapterVersion);
    const existing = byLabel.get(system.label);

    if (existing) {
      existing.executionCount += 1;
      if (execution.observedAt > existing.lastObservedAt) {
        existing.lastObservedAt = execution.observedAt;
      }
    } else {
      byLabel.set(system.label, { label: system.label, subLabel: system.subLabel, executionCount: 1, lastObservedAt: execution.observedAt });
    }

  }

  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));

}

// =========================
// Inventory (list) view
// =========================

export interface AgentManagementItemView {

  agentId: string;

  // Non-empty — every inventory item has at least one evidence source by
  // construction (that is what made it an inventory item at all).
  identityEvidence: AgentIdentityEvidence[];

  registrationStatus: AgentRegistrationStatus;

  aiProvider: null;

  model: null;

  // max(execution.observedAt) among this agent's Executions. null when
  // this agent has no Execution evidence at all (permission-rule-only
  // AIs legitimately have no activity to report — SOR-186 instructions
  // "権限ruleだけのAIでもinventoryには出せる。その場合last activityを
  // 作らない").
  lastActivityAt: string | null;

  // exact agentId match against the (already open/acknowledged-only)
  // Attention items the caller supplied — never re-evaluates Attention
  // semantics.
  activeAttentionCount: number;

  targetSystems: AgentTargetSystemView[];

}

export interface BuildAgentManagementInventoryInput {
  executions: readonly CanonicalExecution[];
  rules: readonly PermissionRegistryRule[];
  // Caller-filtered to the active set (open/acknowledged) — this file
  // never re-decides Attention status semantics.
  attentions: readonly AttentionItemView[];
}

export function buildAgentManagementInventory(
  input: BuildAgentManagementInventoryInput
): AgentManagementItemView[] {

  const agentIds = new Set<string>();

  for (const execution of input.executions) {
    const agentId = normalizeAgentId(execution.agentId);
    if (agentId) agentIds.add(agentId);
  }

  for (const rule of input.rules) {
    const agentId = normalizeAgentId(rule.agentId);
    if (agentId) agentIds.add(agentId);
  }

  const items: AgentManagementItemView[] = [];

  for (const agentId of agentIds) {

    const agentExecutions = executionsForAgent(input.executions, agentId);
    const agentRules = rulesForAgent(input.rules, agentId);
    const agentAttentions = attentionsForAgent(input.attentions, agentId);

    const identityEvidence: AgentIdentityEvidence[] = [];
    if (agentExecutions.length > 0) identityEvidence.push("execution_observed");
    if (agentRules.length > 0) identityEvidence.push("permission_scoped");

    let lastActivityAt: string | null = null;
    for (const execution of agentExecutions) {
      if (lastActivityAt === null || execution.observedAt > lastActivityAt) {
        lastActivityAt = execution.observedAt;
      }
    }

    items.push({
      agentId,
      identityEvidence,
      registrationStatus: "unknown",
      aiProvider: null,
      model: null,
      lastActivityAt,
      activeAttentionCount: agentAttentions.length,
      targetSystems: buildTargetSystems(agentExecutions),
    });

  }

  return items.sort((a, b) => a.agentId.localeCompare(b.agentId));

}

// =========================
// Sidebar filter helpers (same "No business logic in React" delegation as
// permissionManagement.ts's summarize*/filter* functions) — fake counts are
// never introduced; every count here is derived from the actual items
// array the caller already loaded.
// =========================

export interface AgentManagementEvidenceSummary {
  executionObservedCount: number;
  permissionScopedCount: number;
}

// SOR-186 source review fix#3: the sidebar's "実行記録あり"/"権限設定あり"
// counts must be derived here, not via a `.filter(...).length` written
// directly in AgentSidebar — same delegation as summarizeAgentManagement
// ByTargetSystem()/filterAgentManagementItems() below. Counts are always
// mechanically derived from the actual items array; never a fixed/guessed
// value, and an item with both evidence sources is counted in both buckets
// (identityEvidence is not exclusive).
export function summarizeAgentManagementEvidence(
  items: readonly AgentManagementItemView[]
): AgentManagementEvidenceSummary {

  let executionObservedCount = 0;
  let permissionScopedCount = 0;

  for (const item of items) {
    if (item.identityEvidence.includes("execution_observed")) executionObservedCount += 1;
    if (item.identityEvidence.includes("permission_scoped")) permissionScopedCount += 1;
  }

  return { executionObservedCount, permissionScopedCount };

}

export interface AgentManagementTargetSystemFilterOption {
  label: string;
  count: number;
}

export function summarizeAgentManagementByTargetSystem(
  items: readonly AgentManagementItemView[]
): AgentManagementTargetSystemFilterOption[] {

  const counts = new Map<string, number>();

  for (const item of items) {
    for (const system of item.targetSystems) {
      counts.set(system.label, (counts.get(system.label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));

}

export interface AgentManagementFilters {
  search?: string;
  evidence?: AgentIdentityEvidence;
  targetSystemLabel?: string;
}

export function filterAgentManagementItems(
  items: readonly AgentManagementItemView[],
  filters: AgentManagementFilters
): AgentManagementItemView[] {

  const search = filters.search?.trim().toLocaleLowerCase();

  return items.filter((item) => {

    if (filters.evidence && !item.identityEvidence.includes(filters.evidence)) return false;

    if (filters.targetSystemLabel && !item.targetSystems.some((system) => system.label === filters.targetSystemLabel)) {
      return false;
    }

    if (search && !item.agentId.toLocaleLowerCase().includes(search)) {
      return false;
    }

    return true;

  });

}

// =========================
// Detail view — section 2: Identity Source
// =========================

export function identityEvidenceLabel(evidence: AgentIdentityEvidence): string {
  switch (evidence) {
    case "execution_observed": return "実行記録から確認";
    case "permission_scoped": return "権限設定から確認";
  }
}

// =========================
// Detail view — section 3: 責任 / 代理 (Principal / Delegation)
// =========================
//
// Absolute condition (SOR-186 instructions): read exactly
// actorKind/actorId/onBehalfOfActorKind/onBehalfOfActorId off each matching
// Execution. Never infer a Principal from agentId. Delegation entries are
// built ONLY from Executions where onBehalfOfActorKind is non-null — an
// Execution with no delegation evidence contributes nothing (not a
// null-filled placeholder entry).

export function executionActorKindLabel(kind: ExecutionActorKind): string {
  switch (kind) {
    case "human": return "人間";
    case "ai_agent": return "AI";
    case "service": return "サービス";
    case "connector": return "コネクタ";
    case "system": return "システム";
  }
}

export interface AgentPrincipalReferenceView {
  actorKind: ExecutionActorKind;
  actorKindLabel: string;
  actorId: string | null;
  actorLabel: string;
}

export interface AgentDelegationReferenceView {
  onBehalfOfActorKind: ExecutionActorKind;
  onBehalfOfActorKindLabel: string;
  onBehalfOfActorId: string | null;
  actorLabel: string;
}

function buildPrincipalReferences(executions: readonly CanonicalExecution[]): AgentPrincipalReferenceView[] {

  const byKey = new Map<string, AgentPrincipalReferenceView>();

  for (const execution of executions) {
    const key = `${execution.actorKind}::${execution.actorId ?? "\u0000"}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        actorKind: execution.actorKind,
        actorKindLabel: executionActorKindLabel(execution.actorKind),
        actorId: execution.actorId,
        actorLabel: execution.actorId ?? UNCONFIRMED_LABEL,
      });
    }
  }

  return [...byKey.values()];

}

function buildDelegationReferences(executions: readonly CanonicalExecution[]): AgentDelegationReferenceView[] {

  const byKey = new Map<string, AgentDelegationReferenceView>();

  for (const execution of executions) {

    if (execution.onBehalfOfActorKind === null) continue;

    const key = `${execution.onBehalfOfActorKind}::${execution.onBehalfOfActorId ?? "\u0000"}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        onBehalfOfActorKind: execution.onBehalfOfActorKind,
        onBehalfOfActorKindLabel: executionActorKindLabel(execution.onBehalfOfActorKind),
        onBehalfOfActorId: execution.onBehalfOfActorId,
        actorLabel: execution.onBehalfOfActorId ?? UNCONFIRMED_LABEL,
      });
    }

  }

  return [...byKey.values()];

}

// =========================
// Detail view — section 5: Connection evidence (SOR-212 read-only reuse)
// =========================
//
// Absolute condition (SOR-186 instructions): join ONLY on
// execution.connectionId === PublicConnection.id (exact match) — never on
// service/provider name. connectionReadState="unavailable" and "available
// but no exact match" are two different facts with two different messages
// (same discipline as coverageManagement.ts's CONNECTION_READ_UNAVAILABLE_
// MESSAGE / CONNECTION_JOIN_UNAVAILABLE_MESSAGE split) — neither is ever
// reported as "no Connection exists".

const AGENT_CONNECTION_READ_UNAVAILABLE_MESSAGE = "接続情報は現在利用できません";
const AGENT_CONNECTION_NOT_FOUND_MESSAGE = "このAIに紐づくConnectionが確認できません";

export interface AgentConnectionSummaryView {
  connectionId: string;
  service: string;
  provider: string;
  statusLabel: string;
}

export interface AgentConnectionEvidenceView {
  readState: ConnectionReadState;
  connections: AgentConnectionSummaryView[];
  // non-null only when there is nothing to show (either readState is
  // "unavailable", or it is "available" but no exact id match was found).
  unavailableMessage: string | null;
}

function buildConnectionEvidence(
  executions: readonly CanonicalExecution[],
  connectionReadState: ConnectionReadState,
  connections: readonly PublicConnection[]
): AgentConnectionEvidenceView {

  if (connectionReadState === "unavailable") {
    return { readState: "unavailable", connections: [], unavailableMessage: AGENT_CONNECTION_READ_UNAVAILABLE_MESSAGE };
  }

  const connectionIds = [...new Set(
    executions.map((execution) => execution.connectionId).filter((id): id is string => id !== null)
  )];

  const resolved: AgentConnectionSummaryView[] = [];

  for (const connectionId of connectionIds) {
    const match = connections.find((connection) => connection.id === connectionId);
    if (match) {
      resolved.push({
        connectionId: match.id,
        service: match.service,
        provider: match.provider,
        statusLabel: connectionStatusJapanese(match.status),
      });
    }
  }

  return {
    readState: "available",
    connections: resolved,
    unavailableMessage: resolved.length === 0 ? AGENT_CONNECTION_NOT_FOUND_MESSAGE : null,
  };

}

// =========================
// Detail view — section 6: Permission (listOwnedPermissionRules projection
// only — permission evaluation itself is never re-implemented here)
// =========================

function ruleServiceScope(rule: PermissionRegistryRule): ExecutionProvider | null {
  return rule.targetProvider ?? rule.provider;
}

export interface AgentPermissionRuleSummaryView {
  ruleId: string;
  identifier: string;
  decision: PermissionRegistryRule["decision"];
  targetSystemLabel: string;
  actionCategory: PermissionRegistryRule["actionCategory"];
  enabled: boolean;
}

export interface AgentPermissionSummaryView {
  ruleCount: number;
  allowedCount: number;
  approvalRequiredCount: number;
  deniedCount: number;
  rules: AgentPermissionRuleSummaryView[];
  // Non-null ONLY when every rule for this agent shares exactly one
  // service scope — the one case where the exact existing Permission
  // scopeKey (permissionManagement.ts's `${agentId}::${service}` format)
  // is already known without guessing which service to jump to.
  exactScopeKey: string | null;
}

function buildPermissionSummary(agentId: string, rules: readonly PermissionRegistryRule[]): AgentPermissionSummaryView {

  const services = new Set(rules.map((rule) => ruleServiceScope(rule) ?? "\u0000"));
  const exactScopeKey = services.size === 1
    ? `${agentId}::${[...services][0]}`
    : null;

  return {
    ruleCount: rules.length,
    allowedCount: rules.filter((rule) => rule.decision === "allowed").length,
    approvalRequiredCount: rules.filter((rule) => rule.decision === "approval_required").length,
    deniedCount: rules.filter((rule) => rule.decision === "denied").length,
    rules: rules.map((rule) => {
      const service = ruleServiceScope(rule);
      return {
        ruleId: rule.id,
        identifier: rule.identifier,
        decision: rule.decision,
        targetSystemLabel: service !== null ? targetSystemLabel(service, null, null).label : "サービス未指定",
        actionCategory: rule.actionCategory,
        enabled: rule.enabled,
      };
    }),
    exactScopeKey,
  };

}

// =========================
// Detail view — section 7: 最近の仕事 (Work grouping)
// =========================
//
// Absolute condition (SOR-186 instructions): workTitle is read ONLY from
// the caller-supplied, tenant-safe workTitles projection — never fabricated
// when absent. latestExecutionStatus is explicitly the most recently
// OBSERVED Execution's own status, never a claim about the Work's overall
// result.

export interface AgentWorkSummaryView {
  workId: string;
  workTitle: string | null;
  lastAgentActivityAt: string;
  executionCount: number;
  activeAttentionCount: number;
  latestExecutionStatus: ExecutionStatus;
}

function buildWorkSummaries(
  agentId: string,
  executions: readonly CanonicalExecution[],
  attentions: readonly AttentionItemView[],
  workTitles: ReadonlyMap<string, string | null>
): AgentWorkSummaryView[] {

  const byWorkId = new Map<string, CanonicalExecution[]>();

  for (const execution of executions) {
    if (execution.workId === null) continue;
    const bucket = byWorkId.get(execution.workId);
    if (bucket) bucket.push(execution);
    else byWorkId.set(execution.workId, [execution]);
  }

  const summaries: AgentWorkSummaryView[] = [];

  for (const [workId, workExecutions] of byWorkId) {

    let latest = workExecutions[0];
    for (const execution of workExecutions) {
      if (execution.observedAt > latest.observedAt) latest = execution;
    }

    const activeAttentionCount = attentions.filter(
      (item) => normalizeAgentId(item.agentId) === agentId && item.workId === workId
    ).length;

    summaries.push({
      workId,
      workTitle: workTitles.get(workId) ?? null,
      lastAgentActivityAt: latest.observedAt,
      executionCount: workExecutions.length,
      activeAttentionCount,
      latestExecutionStatus: latest.status,
    });

  }

  return summaries.sort((a, b) => b.lastAgentActivityAt.localeCompare(a.lastAgentActivityAt));

}

// =========================
// Detail view — section 8: 最近の実行 (Recent Executions, bounded)
// =========================

const RECENT_EXECUTIONS_LIMIT = 10;

export interface AgentRecentExecutionView {
  executionId: string;
  action: string;
  targetSystem: TargetSystemLabel;
  executionStatus: ExecutionStatus;
  permissionEvaluation: CanonicalPermissionResult;
  observedAt: string;
  workId: string | null;
  workTitle: string | null;
}

function buildRecentExecutions(
  executions: readonly CanonicalExecution[],
  workTitles: ReadonlyMap<string, string | null>
): AgentRecentExecutionView[] {

  return [...executions]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, RECENT_EXECUTIONS_LIMIT)
    .map((execution) => ({
      executionId: execution.id,
      action: actionLabel(execution.operation, execution.provider, execution.targetProvider),
      targetSystem: targetSystemLabel(execution.provider, execution.targetProvider, execution.adapterVersion),
      executionStatus: execution.status,
      permissionEvaluation: toCanonicalPermissionResultFromExecutionStatus(execution.permissionStatus),
      observedAt: execution.observedAt,
      workId: execution.workId,
      workTitle: execution.workId ? workTitles.get(execution.workId) ?? null : null,
    }));

}

// =========================
// Detail view — section 9: 問題 / Attention
// =========================

export interface AgentAttentionSummaryView {
  attentionId: string;
  executionId: string;
  reason: AttentionReason;
  reasonLabel: string;
  createdAt: string;
  workId: string | null;
  workTitle: string | null;
}

function buildAttentionSummaries(attentions: readonly AttentionItemView[]): AgentAttentionSummaryView[] {
  return attentions.map((item) => ({
    attentionId: item.attentionId,
    executionId: item.executionId,
    reason: item.reason,
    reasonLabel: attentionReasonLabel(item.reason),
    createdAt: item.createdAt,
    workId: item.workId,
    workTitle: item.workTitle,
  }));
}

// =========================
// Detail view — assembly
// =========================

export interface AgentManagementDetailView {

  agentId: string;

  identityEvidence: AgentIdentityEvidence[];

  registrationStatus: AgentRegistrationStatus;

  aiProvider: null;

  model: null;

  lastActivityAt: string | null;

  principals: AgentPrincipalReferenceView[];

  delegations: AgentDelegationReferenceView[];

  targetSystems: AgentTargetSystemView[];

  connectionEvidence: AgentConnectionEvidenceView;

  permission: AgentPermissionSummaryView;

  recentWorks: AgentWorkSummaryView[];

  recentExecutions: AgentRecentExecutionView[];

  attentions: AgentAttentionSummaryView[];

}

export interface BuildAgentManagementDetailInput {
  agentId: string;
  executions: readonly CanonicalExecution[];
  rules: readonly PermissionRegistryRule[];
  // Caller-filtered to the active set (open/acknowledged) — same
  // instruction as BuildAgentManagementInventoryInput.attentions.
  attentions: readonly AttentionItemView[];
  workTitles: ReadonlyMap<string, string | null>;
  connectionReadState: ConnectionReadState;
  connections: readonly PublicConnection[];
}

export function buildAgentManagementDetail(
  input: BuildAgentManagementDetailInput
): AgentManagementDetailView {

  const agentExecutions = executionsForAgent(input.executions, input.agentId);
  const agentRules = rulesForAgent(input.rules, input.agentId);
  const agentAttentions = attentionsForAgent(input.attentions, input.agentId);

  const identityEvidence: AgentIdentityEvidence[] = [];
  if (agentExecutions.length > 0) identityEvidence.push("execution_observed");
  if (agentRules.length > 0) identityEvidence.push("permission_scoped");

  let lastActivityAt: string | null = null;
  for (const execution of agentExecutions) {
    if (lastActivityAt === null || execution.observedAt > lastActivityAt) {
      lastActivityAt = execution.observedAt;
    }
  }

  return {
    agentId: input.agentId,
    identityEvidence,
    registrationStatus: "unknown",
    aiProvider: null,
    model: null,
    lastActivityAt,
    principals: buildPrincipalReferences(agentExecutions),
    delegations: buildDelegationReferences(agentExecutions),
    targetSystems: buildTargetSystems(agentExecutions),
    connectionEvidence: buildConnectionEvidence(agentExecutions, input.connectionReadState, input.connections),
    permission: buildPermissionSummary(input.agentId, agentRules),
    recentWorks: buildWorkSummaries(input.agentId, agentExecutions, agentAttentions, input.workTitles),
    recentExecutions: buildRecentExecutions(agentExecutions, input.workTitles),
    attentions: buildAttentionSummaries(agentAttentions),
  };

}
