// =========================
// TACT Runs — Observed AI Management Projection Tests (SOR-186)
// =========================
//
// 対象: core/tact-runs-view/agentManagement.ts の純粋変換関数群。
// DBアクセスを持たないため、fixture(CanonicalExecution /
// PermissionRegistryRule / AttentionItemView / PublicConnection)を直接
// 組み立てて各関数へ渡すだけで検証できる——real Supabaseは不要。

import {
  buildAgentManagementInventory,
  buildAgentManagementDetail,
  filterAgentManagementItems,
  summarizeAgentManagementByTargetSystem,
  summarizeAgentManagementEvidence,
} from "@tact/runs-core/tact-runs-view/agentManagement";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { PermissionRegistryRule } from "@tact/runs-core/tact-execution/permission/types";
import type { AttentionItemView } from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { PublicConnection } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { GITHUB_ISSUE_ADAPTER_VERSION } from "@tact/runs-core/tact-execution/adapters/github/normalizeGithubIssueExecution";
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
    agentId: "agent-1",
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
    agentId: "agent-1",
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
      reasonCode: "approval-required",
      policyId: "policy-1",
      evaluatorVersion: "1",
      evaluatedAt: "2026-09-24T00:00:00.000Z",
    },
    actor: { kind: "human", id: "Sora" },
    agentId: "agent-1",
    provider: "mcp",
    targetProvider: "notion",
    adapterVersion: "notion-mcp-v1",
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
    findings: [],
    ...overrides,
  };
}

function baseConnection(overrides: Partial<PublicConnection> = {}): PublicConnection {
  return {
    id: "connection-1",
    service: "notion",
    status: "active",
    provider: "composio",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // 1. execution agentIdからinventory item生成
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1" })],
      rules: [],
      attentions: [],
    });
    results.push(check(
      "[1] execution agentIdからinventory itemが生成される",
      items.length === 1 && items[0].agentId === "agent-1" && items[0].identityEvidence.includes("execution_observed")
    ));
  }

  // =========================
  // 2. permission rule agentIdのみでもitem生成
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [],
      rules: [baseRule({ agentId: "agent-1" })],
      attentions: [],
    });
    results.push(check(
      "[2] permission rule agentIdのみでもitemが生成される",
      items.length === 1 && items[0].agentId === "agent-1" && items[0].identityEvidence.includes("permission_scoped")
      && !items[0].identityEvidence.includes("execution_observed")
    ));
  }

  // =========================
  // 3. 同一agentId execution + permission ruleは1item
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1" })],
      rules: [baseRule({ agentId: "agent-1" })],
      attentions: [],
    });
    results.push(check(
      "[3] 同一agentIdのexecution+permission ruleは1itemへ統合される",
      items.length === 1 && items[0].identityEvidence.includes("execution_observed") && items[0].identityEvidence.includes("permission_scoped")
    ));
  }

  // =========================
  // 4. agentId nullをinventoryへ入れない
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: null })],
      rules: [baseRule({ agentId: null })],
      attentions: [],
    });
    results.push(check("[4] agentId=nullはinventoryへ入れない", items.length === 0));
  }

  // =========================
  // 5. blank agentIdを入れない
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "   " })],
      rules: [baseRule({ agentId: "" })],
      attentions: [],
    });
    results.push(check("[5] 空白のみ/空文字のagentIdは入れない", items.length === 0));
  }

  // =========================
  // 6. exact agentId only — "agent-1" と "agent-10" を混同しない
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1" }),
        baseExecution({ id: "exec-2", agentId: "agent-10" }),
      ],
      rules: [],
      attentions: [],
    });
    const agent1 = items.find((item) => item.agentId === "agent-1");
    const agent10 = items.find((item) => item.agentId === "agent-10");
    results.push(check(
      "[6] \"agent-1\"と\"agent-10\"は別itemとして扱われ、互いの実行記録を数えない",
      items.length === 2 &&
      agent1 !== undefined && agent1.targetSystems.reduce((sum, s) => sum + s.executionCount, 0) === 1 &&
      agent10 !== undefined && agent10.targetSystems.reduce((sum, s) => sum + s.executionCount, 0) === 1
    ));
  }

  // =========================
  // 7 / 8 / 9. Permission Rule/Executionありをregistered扱いしない、registrationStatusはunknown
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1" })],
      rules: [baseRule({ agentId: "agent-1" })],
      attentions: [],
    });
    results.push(check(
      "[7][8][9] Permission Rule/Executionの有無に関わらずregistrationStatusは常にunknown",
      items[0].registrationStatus === "unknown"
    ));
  }

  // =========================
  // 10 / 11 / 12. Execution.provider/targetProviderをAI providerへ設定しない、AI provider=null、model=null
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1", provider: "mcp", targetProvider: "notion" })],
      rules: [],
      attentions: [],
    });
    results.push(check(
      "[10][11][12] aiProvider/modelは常にnull(execution.provider/targetProviderから設定されない)",
      items[0].aiProvider === null && items[0].model === null
    ));
  }

  // =========================
  // 13. lastActivity=max observedAt
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", observedAt: "2026-09-20T00:00:00.000Z" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", observedAt: "2026-09-25T00:00:00.000Z" }),
        baseExecution({ id: "exec-3", agentId: "agent-1", observedAt: "2026-09-10T00:00:00.000Z" }),
      ],
      rules: [],
      attentions: [],
    });
    results.push(check(
      "[13] lastActivityAtはmax(observedAt)",
      items[0].lastActivityAt === "2026-09-25T00:00:00.000Z"
    ));
  }

  // permission-only agent: lastActivityAt stays null (SOR-186 instructions "権限ruleだけのAIでもinventoryには出せる。その場合last activityを作らない")
  {
    const items = buildAgentManagementInventory({
      executions: [],
      rules: [baseRule({ agentId: "agent-1" })],
      attentions: [],
    });
    results.push(check(
      "[13] permission ruleのみのAIはlastActivityAt=null(作らない)",
      items[0].lastActivityAt === null
    ));
  }

  // =========================
  // 14. Workはexact workIdでunique grouping
  // =========================
  {
    const detail = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", workId: "work-1", observedAt: "2026-09-20T00:00:00.000Z" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", workId: "work-1", observedAt: "2026-09-22T00:00:00.000Z" }),
        baseExecution({ id: "exec-3", agentId: "agent-1", workId: "work-2", observedAt: "2026-09-21T00:00:00.000Z" }),
      ],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    const work1 = detail.recentWorks.find((w) => w.workId === "work-1");
    results.push(check(
      "[14] 同じworkIdの複数executionは1つのWork groupへunique化される",
      detail.recentWorks.length === 2 && work1 !== undefined && work1.executionCount === 2
    ));
  }

  // =========================
  // 15. Work titleはsupplied projectionからのみ
  // =========================
  {
    const detailWithTitle = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", workId: "work-1" })],
      rules: [],
      attentions: [],
      workTitles: new Map([["work-1", "Quarterly report"]]),
      connectionReadState: "unavailable",
      connections: [],
    });
    const detailWithoutTitle = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", workId: "work-1" })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    results.push(check(
      "[15] workTitleは渡されたprojection mapからのみ取得される。無ければnull(fabricateしない)",
      detailWithTitle.recentWorks[0].workTitle === "Quarterly report" &&
      detailWithoutTitle.recentWorks[0].workTitle === null
    ));
  }

  // =========================
  // 16. latest Execution statusをWork resultと呼ばないprojection
  // =========================
  {
    const detail = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", workId: "work-1", observedAt: "2026-09-20T00:00:00.000Z", status: "failed" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", workId: "work-1", observedAt: "2026-09-25T00:00:00.000Z", status: "succeeded" }),
      ],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    const work = detail.recentWorks[0];
    results.push(check(
      "[16] latestExecutionStatusは最新observedAtのexecution自身のstatus(Work全体のresultではない、fieldにresult/outcomeという命名もしない)",
      work.latestExecutionStatus === "succeeded" &&
      Object.keys(work).sort().join(",") === "activeAttentionCount,executionCount,lastAgentActivityAt,latestExecutionStatus,workId,workTitle"
    ));
  }

  // =========================
  // 17 / 18. Attention exact agentId match、resolvedは渡されなければactiveに入らない
  // =========================
  {
    const detail = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1" })],
      rules: [],
      attentions: [
        baseAttentionItem({ attentionId: "attn-1", agentId: "agent-1", status: "open" }),
        baseAttentionItem({ attentionId: "attn-2", agentId: "agent-2", status: "open" }),
      ],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    results.push(check(
      "[17] Attentionはexact agentId matchだけがこのAIのattentionとして数えられる",
      detail.attentions.length === 1 && detail.attentions[0].attentionId === "attn-1"
    ));
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1" })],
      rules: [],
      // caller is expected to pass active-only (open/acknowledged) attentions —
      // this projection trusts that input and does not re-filter by status.
      attentions: [baseAttentionItem({ agentId: "agent-1", status: "open" })],
    });
    results.push(check(
      "[18] resolved Attentionはroute側がactiveのみ渡す前提——projectionはstatusを再判定せずcountする(ここではactive入力のみで確認)",
      items[0].activeAttentionCount === 1
    ));
  }

  // =========================
  // 19. Principal exact evidence only
  // =========================
  {
    const detail = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", actorKind: "human", actorId: "sora" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", actorKind: "human", actorId: "sora" }),
        baseExecution({ id: "exec-3", agentId: "agent-1", actorKind: "service", actorId: null }),
      ],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    results.push(check(
      "[19] Principalはexecution.actorKind/actorIdをそのまま読み、distinct化する(agentIdからの推測ではない)",
      detail.principals.length === 2 &&
      detail.principals.some((p) => p.actorKind === "human" && p.actorId === "sora") &&
      detail.principals.some((p) => p.actorKind === "service" && p.actorId === null && p.actorLabel === "確認できません")
    ));
  }

  // =========================
  // 20. onBehalfOf exact evidence only
  // =========================
  {
    const detailWithDelegation = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", onBehalfOfActorKind: "human", onBehalfOfActorId: "manager-1" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", onBehalfOfActorKind: null, onBehalfOfActorId: null }),
      ],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    const detailWithoutDelegation = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", onBehalfOfActorKind: null, onBehalfOfActorId: null })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [],
    });
    results.push(check(
      "[20] delegationはonBehalfOfActorKindが非nullのexecutionからのみ構築される。無いexecutionは1件もdelegationを生まない",
      detailWithDelegation.delegations.length === 1 &&
      detailWithDelegation.delegations[0].onBehalfOfActorId === "manager-1" &&
      detailWithoutDelegation.delegations.length === 0
    ));
  }

  // =========================
  // 21. target system grouping uses existing targetSystemLabel semantics
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", provider: "mcp", targetProvider: "notion" }),
        baseExecution({ id: "exec-2", agentId: "agent-1", provider: "notion", targetProvider: null }),
      ],
      rules: [],
      attentions: [],
    });
    results.push(check(
      "[21] target systemのlabelはtargetSystemLabel()(targetProvider ?? provider)でgroupingされる——同じ実態(Notion)は1 systemとして集約",
      items[0].targetSystems.length === 1 && items[0].targetSystems[0].label === "Notion" && items[0].targetSystems[0].executionCount === 2
    ));
  }

  // =========================
  // 22. GitHub custom adapter presentationを壊さない
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [baseExecution({ agentId: "agent-1", provider: "custom", targetProvider: null, adapterVersion: GITHUB_ISSUE_ADAPTER_VERSION })],
      rules: [],
      attentions: [],
    });
    results.push(check(
      "[22] provider=\"custom\"かつGitHub adapterVersionの場合、既存のGitHub presentation override(\"GitHub\"ラベル)が維持される",
      items[0].targetSystems.length === 1 && items[0].targetSystems[0].label === "GitHub"
    ));
  }

  // =========================
  // 23 / 24. connection exact id join only、service/provider名だけでjoinしない
  // =========================
  {
    const detailExactMatch = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", connectionId: "connection-1" })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "available",
      connections: [baseConnection({ id: "connection-1" })],
    });
    results.push(check(
      "[23] execution.connectionId === PublicConnection.idのexact matchのみjoinする",
      detailExactMatch.connectionEvidence.connections.length === 1 &&
      detailExactMatch.connectionEvidence.connections[0].connectionId === "connection-1"
    ));

    const detailNoMatch = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", connectionId: "connection-does-not-exist", provider: "notion" })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "available",
      connections: [baseConnection({ id: "connection-1", service: "notion", provider: "composio" })],
    });
    results.push(check(
      "[24] serviceやproviderの名称だけが一致してもjoinしない——idが一致しなければ未確認として扱う",
      detailNoMatch.connectionEvidence.connections.length === 0 &&
      detailNoMatch.connectionEvidence.unavailableMessage === "このAIに紐づくConnectionが確認できません"
    ));
  }

  // =========================
  // 25. connectionReadState unavailableをno connection扱いしない
  // =========================
  {
    const detailUnavailable = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", connectionId: "connection-1" })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "unavailable",
      connections: [baseConnection({ id: "connection-1" })],
    });
    const detailAvailableNoMatch = buildAgentManagementDetail({
      agentId: "agent-1",
      executions: [baseExecution({ agentId: "agent-1", connectionId: "connection-missing" })],
      rules: [],
      attentions: [],
      workTitles: new Map(),
      connectionReadState: "available",
      connections: [],
    });
    results.push(check(
      "[25] connectionReadState=unavailableは「Connectionが無い」とは別のmessageになり、joinを一切試みない",
      detailUnavailable.connectionEvidence.readState === "unavailable" &&
      detailUnavailable.connectionEvidence.unavailableMessage === "接続情報は現在利用できません" &&
      detailUnavailable.connectionEvidence.unavailableMessage !== detailAvailableNoMatch.connectionEvidence.unavailableMessage
    ));
  }

  // =========================
  // 26. filter countsはactual itemから導出
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-1", provider: "mcp", targetProvider: "notion" }),
        baseExecution({ id: "exec-2", agentId: "agent-2", provider: "mcp", targetProvider: "notion" }),
        baseExecution({ id: "exec-3", agentId: "agent-3", provider: "slack", targetProvider: null }),
      ],
      rules: [],
      attentions: [],
    });
    const options = summarizeAgentManagementByTargetSystem(items);
    const notionOption = options.find((o) => o.label === "Notion");
    const slackOption = options.find((o) => o.label === "Slack");
    results.push(check(
      "[26] filter選択肢のcountは実際のitems配列から機械的に数えた値であり、固定値ではない",
      notionOption !== undefined && notionOption.count === 2 &&
      slackOption !== undefined && slackOption.count === 1
    ));
  }

  // =========================
  // 27. search/filter pure function
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        baseExecution({ id: "exec-1", agentId: "agent-alpha", provider: "mcp", targetProvider: "notion" }),
        baseExecution({ id: "exec-2", agentId: "agent-beta", provider: "slack", targetProvider: null }),
      ],
      rules: [baseRule({ id: "rule-only", agentId: "agent-gamma" })],
      attentions: [],
    });
    const bySearch = filterAgentManagementItems(items, { search: "alpha" });
    const byEvidence = filterAgentManagementItems(items, { evidence: "permission_scoped" });
    const byTargetSystem = filterAgentManagementItems(items, { targetSystemLabel: "Slack" });
    results.push(check(
      "[27] search/evidence/targetSystemLabelによる絞り込みは、Reactに書かれた判定ではなくこのpure関数が行う",
      bySearch.length === 1 && bySearch[0].agentId === "agent-alpha" &&
      byEvidence.length === 1 && byEvidence[0].agentId === "agent-gamma" &&
      byTargetSystem.length === 1 && byTargetSystem[0].agentId === "agent-beta"
    ));
  }

  // =========================
  // 28. summarizeAgentManagementEvidence(): execution_observedのみ /
  // permission_scopedのみ / 両方を持つitem / 実件数からの正しいcount /
  // 重複・fake countなし (SOR-186 source review fix#3)
  // =========================
  {
    const items = buildAgentManagementInventory({
      executions: [
        // agent-exec-only: execution evidenceのみ
        baseExecution({ id: "exec-1", agentId: "agent-exec-only" }),
        // agent-both: execution + permission rule両方
        baseExecution({ id: "exec-2", agentId: "agent-both" }),
      ],
      rules: [
        // agent-rule-only: permission evidenceのみ
        baseRule({ id: "rule-1", agentId: "agent-rule-only" }),
        baseRule({ id: "rule-2", agentId: "agent-both" }),
      ],
      attentions: [],
    });

    results.push(check(
      "[28] inventoryにexecution_observedのみ/permission_scopedのみ/両方を持つitemがそれぞれ存在する(fixtureの前提確認)",
      items.length === 3 &&
      items.some((item) => item.agentId === "agent-exec-only" && item.identityEvidence.length === 1 && item.identityEvidence[0] === "execution_observed") &&
      items.some((item) => item.agentId === "agent-rule-only" && item.identityEvidence.length === 1 && item.identityEvidence[0] === "permission_scoped") &&
      items.some((item) => item.agentId === "agent-both" && item.identityEvidence.includes("execution_observed") && item.identityEvidence.includes("permission_scoped"))
    ));

    const summary = summarizeAgentManagementEvidence(items);

    results.push(check(
      "[28] executionObservedCountは実行記録を持つitem数(agent-exec-only + agent-both = 2件)を機械的に数えた値——固定値でも重複数えでもない",
      summary.executionObservedCount === 2
    ));

    results.push(check(
      "[28] permissionScopedCountは権限設定を持つitem数(agent-rule-only + agent-both = 2件)を機械的に数えた値",
      summary.permissionScopedCount === 2
    ));

    results.push(check(
      "[28] 空のitems配列ではcountが両方0になる(fake countが残らない)",
      summarizeAgentManagementEvidence([]).executionObservedCount === 0 &&
      summarizeAgentManagementEvidence([]).permissionScopedCount === 0
    ));
  }

  return summarize("runsView/agentManagementProjection", results);

}
