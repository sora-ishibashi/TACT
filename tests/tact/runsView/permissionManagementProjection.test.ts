// =========================
// TACT Runs — Permission Management Projection Tests (SOR-187)
// =========================
//
// 対象: core/tact-runs-view/permissionManagement.ts の純粋変換関数群。
// DBアクセスを持たないため、fixture(PermissionRegistryRule /
// CanonicalExecution / PermissionDecision / DownstreamPermissionEvidence)
// を直接組み立ててbuildPermissionManagementScopes()へ渡すだけで検証
// できる——real Supabaseは不要。

import {
  buildPermissionManagementScopes,
  filterPermissionScopes,
  type PermissionScopeView,
} from "@tact/runs-core/tact-runs-view/permissionManagement";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { PermissionDecision, PermissionRegistryRule } from "@tact/runs-core/tact-execution/permission/types";
import type { DownstreamPermissionEvidence } from "@tact/runs-core/tact-execution/downstreamPermission/types";
import { check, summarize, type CheckResult } from "../lib/check";

// =========================
// Fixture builders (test-only)
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
    actionCategory: "update",
    operation: "notion_update_page",
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

function baseRule(overrides: Partial<PermissionRegistryRule> = {}): PermissionRegistryRule {
  return {
    id: "rule-1",
    userId: "user-1",
    identifier: "notion-update-allow",
    revision: 1,
    subjectKind: null,
    actorId: null,
    agentId: "Claude Test Agent",
    provider: null,
    targetProvider: "notion",
    resourceType: "page",
    actionCategory: "update",
    decision: "allowed",
    reasonCode: "registry_match",
    requiresKnownActorId: false,
    requiresKnownAgentId: false,
    connectionId: null,
    priority: 0,
    validFrom: null,
    validUntil: null,
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseDecision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    executionId: "exec-1",
    status: "allowed",
    reasonCode: "registry_match",
    policyId: "rule-1",
    evaluatorVersion: "registry-v1",
    metadata: null,
    evaluatedAt: "2026-09-24T00:00:00.000Z",
    registryRuleId: "rule-1",
    registryRuleRevision: 1,
    ...overrides,
  };
}

function baseEvidence(overrides: Partial<DownstreamPermissionEvidence> = {}): DownstreamPermissionEvidence {
  return {
    id: "evidence-1",
    userId: "user-1",
    executionId: "exec-1",
    targetProvider: "notion",
    connectionId: null,
    subjectKind: "human",
    subjectId: "Sora",
    agentId: "Claude Test Agent",
    actionCategory: "update",
    operation: "notion_update_page",
    resourceType: "page",
    resourceIdentifier: "page-1",
    permissionState: "allowed",
    sourceType: "connector_acl",
    sourceIdentifier: null,
    authorityLevel: "AUTHORITATIVE",
    trustLevel: "INTERNAL",
    observedAt: "2026-09-24T00:00:00.000Z",
    recordedAt: "2026-09-24T00:00:01.000Z",
    evidenceSnapshot: null,
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // registered rule / downstream evidence / actual actionが混ざらない
  // =========================
  {
    const rule = baseRule();
    const execution = baseExecution();
    const decision = baseDecision();
    const evidence = baseEvidence();

    const scopes = buildPermissionManagementScopes({
      rules: [rule],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map([["exec-1", [evidence]]]),
    });

    const scope = scopes.find((s: PermissionScopeView) => s.scopeKey === scopes[0].scopeKey)!;

    results.push(check(
      "[SOR-187] registered rules / downstream evidence / actual actions stay in separate arrays",
      scope.registeredRules.length === 1 &&
      scope.registeredRules[0].id === "rule-1" &&
      scope.downstreamEvidence.length === 1 &&
      scope.downstreamEvidence[0].evidenceId === "evidence-1" &&
      scope.actualActions.length === 1 &&
      scope.actualActions[0].executionId === "exec-1" &&
      !("decision" in scope.actualActions[0]) &&
      !("permissionState" in scope.registeredRules[0])
    ));
  }

  // =========================
  // evidence無し → unknown (downstreamPermissionUnknown相当。この画面
  // では「接続先の権限情報を確認できません」をUI側が0件配列から出す
  // ——ここではevidence配列が実際に0件であることだけを確認する)
  // =========================
  {
    const execution = baseExecution();
    const decision = baseDecision();

    const scopes = buildPermissionManagementScopes({
      rules: [],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map(),
    });

    const scope = scopes[0];

    results.push(check(
      "[SOR-187] no evidence rows -> downstreamEvidence is empty, not fabricated",
      scope.downstreamEvidence.length === 0 && scope.hasConflict === false
    ));
  }

  // =========================
  // CONFLICTのみ衝突
  // =========================
  {
    const execution = baseExecution();
    const decision = baseDecision({ status: "allowed" });
    const evidence = baseEvidence({ permissionState: "denied" }); // runs=allowed, downstream=denied -> CONFLICT

    const scopes = buildPermissionManagementScopes({
      rules: [],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map([["exec-1", [evidence]]]),
    });

    const scope = scopes[0];

    results.push(check(
      "[SOR-187] a CONFLICT relation sets hasConflict=true",
      scope.hasConflict === true &&
      scope.downstreamEvidence[0].relationToRuns === "CONFLICT" &&
      scope.downstreamEvidence[0].relationToRunsLabel === "接続先との衝突"
    ));
  }

  // =========================
  // NOT_COMPARABLEを衝突扱いしない
  // =========================
  {
    const execution = baseExecution();
    const decision = baseDecision({ status: "approval_required" }); // not a definite allowed/denied -> NOT_COMPARABLE
    const evidence = baseEvidence({ permissionState: "allowed" });

    const scopes = buildPermissionManagementScopes({
      rules: [],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map([["exec-1", [evidence]]]),
    });

    const scope = scopes[0];

    results.push(check(
      "[SOR-187] NOT_COMPARABLE is never treated as a conflict",
      scope.downstreamEvidence[0].relationToRuns === "NOT_COMPARABLE" &&
      scope.hasConflict === false
    ));
  }

  // =========================
  // targetProvider unknownを推測しない(compare.tsの絶対条件: execution.
  // targetProvider===nullをproviderで補完しない。この projectionは
  // execution.targetProviderをそのままcompareDownstreamPermissionEvidence()
  // へ渡すだけで、自分では一切補完しない)
  // =========================
  {
    const execution = baseExecution({ targetProvider: null, provider: "notion" });
    const decision = baseDecision({ status: "allowed" });
    const evidence = baseEvidence({ targetProvider: "notion" });

    const scopes = buildPermissionManagementScopes({
      rules: [],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map([["exec-1", [evidence]]]),
    });

    const scope = scopes[0];

    results.push(check(
      "[SOR-187] execution.targetProvider=null is never backfilled from provider for evidence applicability",
      scope.downstreamEvidence[0].relationToRuns === "NOT_APPLICABLE" &&
      scope.downstreamEvidence[0].relationToRunsLabel === "対象外"
    ));
  }

  // =========================
  // AI/service missingを明示
  // =========================
  {
    const execution = baseExecution({ agentId: null, provider: "custom", targetProvider: null });

    const scopes = buildPermissionManagementScopes({
      rules: [],
      executions: [execution],
      decisionsByExecutionId: new Map(),
      evidenceByExecutionId: new Map(),
    });

    const scope = scopes[0];

    results.push(check(
      "[SOR-187] null agentId/service are shown with the explicit unspecified labels, never blank or guessed",
      scope.agentId === null &&
      scope.agentDisplayLabel === "AI未指定" &&
      scope.serviceScope === "custom" &&
      scope.serviceDisplayLabel !== "" &&
      scope.serviceDisplayLabel !== "AI未指定"
    ));
  }

  // =========================
  // rule-only scope（執行無し）が推測で消えない / needs-confirmation filter
  // =========================
  {
    const rule = baseRule({ agentId: "Other Agent", targetProvider: "slack" });
    const execution = baseExecution();
    const decision = baseDecision({ status: "allowed" });
    const evidence = baseEvidence({ permissionState: "denied" });

    const scopes = buildPermissionManagementScopes({
      rules: [rule],
      executions: [execution],
      decisionsByExecutionId: new Map([["exec-1", [decision]]]),
      evidenceByExecutionId: new Map([["exec-1", [evidence]]]),
    });

    results.push(check(
      "[SOR-187] a rule with no matching execution still produces its own scope",
      scopes.some((s) => s.agentId === "Other Agent" && s.serviceScope === "slack" && s.actualActions.length === 0 && s.registeredRules.length === 1)
    ));

    const filtered = filterPermissionScopes(scopes, { needsConfirmationOnly: true });
    results.push(check(
      "[SOR-187] filterPermissionScopes(needsConfirmationOnly) keeps only hasConflict scopes",
      filtered.length === 1 && filtered[0].hasConflict === true
    ));
  }

  return summarize("runsView/permissionManagementProjection", results);

}
