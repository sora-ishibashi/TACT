// =========================
// TACT Canonical Execution — Permission Registry Evaluator Regression (SOR-47)
// =========================
//
// 対象: core/tact-execution/permission/registryEvaluate.tsの
// matchesRegistryRule()/isPermissionRuleValidAt()/
// evaluatePermissionFromRegistry()(純粋関数、DBアクセスなし)。
//
// Human Owner指示の2つの絶対条件を特に厳密に検証する:
//   1. 同一tier+priorityで複数ruleがmatchした場合、decisionが一致
//      していても必ずUNKNOWN(ambiguous_registry_rules)へfail closed
//      する(「推測で選ばない」、2回目の修正指示)。
//   2. tenant ruleは常にglobal fallback ruleに優先する
//      (restrictive overlay層は存在しない、v1-minimal)。
//
// 「seeded-registry equivalence」: supabase/migrations/
// 20261030000000...sqlが種入れする7つのglobal fallback ruleを、この
// fileでも同じ内容のPermissionRegistryRuleとして再現し、既存の静的
// allowlist経由のevaluatePermission()(core/tact-execution/permission/
// evaluate.ts、cutoverされておらず今も本番既定)と、同じExecution入力
// に対して同じstatus/reasonCode/policyId(identifier)を返すことを
// 確認する——新evaluatorが既存Notion/Slack挙動を正しく再現できる
// ことの根拠(cutoverの判断材料、Phase1では未接続のまま)。

import {
  matchesRegistryRule,
  isPermissionRuleValidAt,
  evaluatePermissionFromRegistry,
  PERMISSION_REGISTRY_EVALUATOR_VERSION,
} from "@tact/runs-core/tact-execution/permission/registryEvaluate";
import { evaluatePermission } from "@tact/runs-core/tact-execution/permission/evaluate";
import { resolvePermissionSubject } from "@tact/runs-core/tact-execution/permission/resolveSubject";
import type { PermissionRegistryRule, PermissionSubject } from "@tact/runs-core/tact-execution/permission/types";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: null,
    actorKind: "human",
    actorId: "U123",
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev1",
    adapterVersion: "v1",
    sourceMetadata: null,
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "create",
    operation: "app_mention",
    resourceType: "slack_message",
    resourceIdentifier: null,
    targetProvider: "slack",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "unknown",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T00:00:00.000Z",
    persistedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

let ruleIdCounter = 1;

function makeRule(overrides: Partial<PermissionRegistryRule> = {}): PermissionRegistryRule {
  return {
    id: `rule-${ruleIdCounter++}`,
    userId: null,
    identifier: "test-rule",
    revision: 1,
    subjectKind: null,
    actorId: null,
    agentId: null,
    provider: null,
    targetProvider: null,
    resourceType: null,
    actionCategory: null,
    decision: "allowed",
    reasonCode: "test_reason",
    requiresKnownActorId: false,
    requiresKnownAgentId: false,
    connectionId: null,
    priority: 0,
    validFrom: null,
    validUntil: null,
    enabled: true,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- matchesRegistryRule: 5 principal/agent cases (Human Owner指示section1) ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "Sora" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "Sora", agentId: "Claude Sales Agent", provider: "salesforce", targetProvider: "salesforce", actionCategory: "read" });

    results.push(check("[Principal/Agent] wildcard subject(actorId/agentId共にnull)は任意のexecutionにmatchする", matchesRegistryRule(makeRule(), subject, execution)));

    results.push(
      check(
        "[Principal/Agent] subject kind onlyは同じkindの任意のprincipal/agentにmatchする",
        matchesRegistryRule(makeRule({ subjectKind: "ai_agent" }), subject, execution)
      )
    );

    results.push(
      check(
        "[Principal/Agent] 特定principal(actorId='Sora')指定、agent不問はagentIdに関わらずmatchする",
        matchesRegistryRule(makeRule({ actorId: "Sora" }), subject, execution) &&
          matchesRegistryRule(makeRule({ actorId: "Sora" }), subject, makeExecution({ ...execution, agentId: "Other Agent" }))
      )
    );

    results.push(
      check(
        "[Principal/Agent] 特定agent(agentId='Claude Sales Agent')指定、principal不問は別のactorIdでもmatchする",
        matchesRegistryRule(makeRule({ agentId: "Claude Sales Agent" }), { kind: "ai_agent", id: "SomeoneElse" }, execution)
      )
    );

    results.push(
      check(
        "[Principal/Agent] 特定principal+agent(Sora + Claude Sales Agent)は両方一致した場合のみmatchする",
        matchesRegistryRule(makeRule({ actorId: "Sora", agentId: "Claude Sales Agent" }), subject, execution) &&
          !matchesRegistryRule(makeRule({ actorId: "Sora", agentId: "Claude Sales Agent" }), subject, makeExecution({ ...execution, agentId: "Other Agent" })) &&
          !matchesRegistryRule(makeRule({ actorId: "Sora", agentId: "Claude Sales Agent" }), { kind: "ai_agent", id: "NotSora" }, execution)
      )
    );
  }

  // ---- connection/account scope ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1", connectionId: "conn-1" });

    results.push(check("[Connection] connectionId未設定のruleはどのconnectionでもmatchする", matchesRegistryRule(makeRule(), subject, execution)));
    results.push(check("[Connection] 一致するconnectionIdはmatchする", matchesRegistryRule(makeRule({ connectionId: "conn-1" }), subject, execution)));
    results.push(check("[Connection] 不一致のconnectionIdはmatchしない", !matchesRegistryRule(makeRule({ connectionId: "conn-2" }), subject, execution)));
  }

  // ---- validity window: [valid_from, valid_until) 半開区間 ----
  {
    const rule = makeRule({ validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-02-01T00:00:00.000Z" });

    results.push(check("[Validity] valid_from直前はまだ無効", !isPermissionRuleValidAt(rule, new Date("2025-12-31T23:59:59.999Z"))));
    results.push(check("[Validity] valid_fromちょうどは有効(inclusive)", isPermissionRuleValidAt(rule, new Date("2026-01-01T00:00:00.000Z"))));
    results.push(check("[Validity] valid_until直前はまだ有効", isPermissionRuleValidAt(rule, new Date("2026-01-31T23:59:59.999Z"))));
    results.push(check("[Validity] valid_untilちょうどは無効(exclusive、半開区間)", !isPermissionRuleValidAt(rule, new Date("2026-02-01T00:00:00.000Z"))));
    results.push(check("[Validity] valid_from/valid_until共にnullは常に有効", isPermissionRuleValidAt(makeRule(), new Date("2099-01-01T00:00:00.000Z"))));
  }

  // ---- tenant precedence over global fallback ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1", provider: "notion", targetProvider: "notion", actionCategory: "update" });

    const globalRule = makeRule({ userId: null, identifier: "global-update-approval", targetProvider: "notion", actionCategory: "update", decision: "approval_required", priority: 0 });
    const tenantRule = makeRule({ userId: "user-1", identifier: "tenant-update-allowed", targetProvider: "notion", actionCategory: "update", decision: "allowed", priority: 99 });

    const decision = evaluatePermissionFromRegistry(subject, execution, [globalRule, tenantRule]);

    results.push(
      check(
        "[Precedence] tenant ruleはpriorityがglobalより低優先(数値が大きい)でもglobalに優先する(restrictive overlay層が無いv1-minimalの意図した挙動)",
        decision.status === "allowed" && decision.policyId === "tenant-update-allowed"
      )
    );
  }

  // ---- ambiguity: same tier+priority, SAME decision -> still UNKNOWN (絶対条件) ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1" });

    const ruleA = makeRule({ identifier: "rule-a", priority: 0, decision: "allowed" });
    const ruleB = makeRule({ identifier: "rule-b", priority: 0, decision: "allowed" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [ruleA, ruleB]);

    results.push(
      check(
        "[Ambiguity/絶対条件] 同一tier+priorityで複数ruleがmatchし、decisionが一致していてもUNKNOWNへfail closedする(推測で選ばない、Human Owner 2回目の修正指示)",
        decision.status === "unknown" && decision.reasonCode === "ambiguous_registry_rules" && decision.registryRuleId === null
      )
    );
  }

  // ---- ambiguity: same tier+priority, DIFFERENT decision -> UNKNOWN ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1" });

    const ruleA = makeRule({ identifier: "rule-a", priority: 0, decision: "allowed" });
    const ruleB = makeRule({ identifier: "rule-b", priority: 0, decision: "denied" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [ruleA, ruleB]);

    results.push(check("[Ambiguity] 同一tier+priorityでdecisionが矛盾する場合もUNKNOWNへfail closedする", decision.status === "unknown" && decision.reasonCode === "ambiguous_registry_rules"));
  }

  // ---- lower priority value wins when unambiguous ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1" });

    const higher = makeRule({ identifier: "low-priority-number-wins", priority: 0, decision: "denied" });
    const lower = makeRule({ identifier: "higher-priority-number-loses", priority: 5, decision: "allowed" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [higher, lower]);

    results.push(check("[Priority] priority値が最小のruleが単独で勝つ場合はそのまま使われる(曖昧でない)", decision.status === "denied" && decision.policyId === "low-priority-number-wins"));
  }

  // ---- no match at all -> unknown/no_matching_registry_rule ----
  {
    const subject: PermissionSubject = { kind: "human", id: "H1" };
    const execution = makeExecution({ actorKind: "human", actorId: "H1", provider: "gmail" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [makeRule({ provider: "slack" })]);

    results.push(check("[No match] matchするruleが無い場合はunknown/no_matching_registry_ruleを返す(allowedへfallbackしない)", decision.status === "unknown" && decision.reasonCode === "no_matching_registry_rule" && decision.policyId === null));
  }

  // ---- disabled rule is never a candidate ----
  {
    const subject: PermissionSubject = { kind: "human", id: "H1" };
    const execution = makeExecution({ actorKind: "human", actorId: "H1" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [makeRule({ enabled: false, decision: "allowed" })]);

    results.push(check("[Disabled] enabled=falseのruleはmatch候補から除外される", decision.status === "unknown" && decision.reasonCode === "no_matching_registry_rule"));
  }

  // ---- historical explainability: matched decision carries registryRuleId/revision/snapshot ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "A1" };
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "A1" });

    const rule = makeRule({ id: "rule-xyz", identifier: "explainable-rule", revision: 7, decision: "approval_required", reasonCode: "needs_review" });

    const decision = evaluatePermissionFromRegistry(subject, execution, [rule]);

    results.push(
      check(
        "[Historical explainability] matchしたdecisionはregistryRuleId/registryRuleRevisionと、現在の行を参照せずに説明できるfield snapshotをmetadataへ持つ",
        decision.registryRuleId === "rule-xyz" &&
          decision.registryRuleRevision === 7 &&
          decision.policyId === "explainable-rule" &&
          decision.evaluatorVersion === PERMISSION_REGISTRY_EVALUATOR_VERSION &&
          typeof decision.metadata === "object" &&
          decision.metadata !== null &&
          (decision.metadata as Record<string, unknown>).revision === 7 &&
          (decision.metadata as Record<string, unknown>).identifier === "explainable-rule"
      )
    );
  }

  // ---- seeded-registry equivalence vs the existing static allowlist evaluator ----
  {
    // supabase/migrations/20261030000000...sqlのseedと1:1対応(user_id=
    // null=global fallback、priorityは既存配列の宣言順)。
    const seededRules: PermissionRegistryRule[] = [
      makeRule({ identifier: "human-slack-mention-allowed", subjectKind: "human", provider: "slack", targetProvider: null, resourceType: "slack_message", actionCategory: "create", decision: "allowed", reasonCode: "human_slack_mention_allowed", priority: 0 }),
      makeRule({ identifier: "ai-agent-slack-channel-read-allowed", subjectKind: "ai_agent", provider: "slack", targetProvider: null, resourceType: "slack_channel", actionCategory: "read", decision: "allowed", reasonCode: "ai_agent_slack_channel_read_allowed", priority: 1 }),
      makeRule({ identifier: "ai-agent-slack-message-send-denied", subjectKind: "ai_agent", provider: "slack", targetProvider: null, resourceType: "slack_message", actionCategory: "send", decision: "denied", reasonCode: "ai_agent_slack_message_send_denied", priority: 2 }),
      makeRule({ identifier: "notion-ai-agent-read-allowed", subjectKind: "ai_agent", provider: null, targetProvider: "notion", resourceType: null, actionCategory: "read", decision: "allowed", reasonCode: "notion_m0_read_allowed", requiresKnownActorId: true, requiresKnownAgentId: true, priority: 3 }),
      makeRule({ identifier: "notion-ai-agent-create-page-allowed", subjectKind: "ai_agent", provider: null, targetProvider: "notion", resourceType: null, actionCategory: "create", decision: "allowed", reasonCode: "notion_m0_create_page_allowed", requiresKnownActorId: true, requiresKnownAgentId: true, priority: 4 }),
      makeRule({ identifier: "notion-ai-agent-update-page-approval-required", subjectKind: "ai_agent", provider: null, targetProvider: "notion", resourceType: null, actionCategory: "update", decision: "approval_required", reasonCode: "notion_m0_update_page_approval_required", requiresKnownActorId: true, requiresKnownAgentId: true, priority: 5 }),
      makeRule({ identifier: "notion-ai-agent-delete-page-denied", subjectKind: "ai_agent", provider: null, targetProvider: "notion", resourceType: null, actionCategory: "delete", decision: "denied", reasonCode: "notion_m0_delete_page_forbidden", requiresKnownActorId: true, requiresKnownAgentId: true, priority: 6 }),
    ];

    const representativeExecutions: CanonicalExecution[] = [
      makeExecution({ actorKind: "human", actorId: "U1", provider: "slack", targetProvider: "slack", resourceType: "slack_message", actionCategory: "create" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", provider: "slack", targetProvider: "slack", resourceType: "slack_channel", actionCategory: "read" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", provider: "slack", targetProvider: "slack", resourceType: "slack_message", actionCategory: "send" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", agentId: "Claude Test Agent", provider: "mcp", targetProvider: "notion", resourceType: "page", actionCategory: "read" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", agentId: "Claude Test Agent", provider: "mcp", targetProvider: "notion", resourceType: "page", actionCategory: "create" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", agentId: "Claude Test Agent", provider: "mcp", targetProvider: "notion", resourceType: "page", actionCategory: "update" }),
      makeExecution({ actorKind: "ai_agent", actorId: "A1", agentId: "Claude Test Agent", provider: "mcp", targetProvider: "notion", resourceType: "page", actionCategory: "delete" }),
      // 未知のactorId(Notion系、requiresKnownActorId=trueにより静的
      // allowlist側もmatchせずunknownへ倒れるケース)。
      makeExecution({ actorKind: "ai_agent", actorId: null, agentId: null, provider: "mcp", targetProvider: "notion", resourceType: "page", actionCategory: "read" }),
      // どのruleにもmatchしないケース(gmail、7rule中に一切登場しない)。
      makeExecution({ actorKind: "human", actorId: "U1", provider: "gmail", targetProvider: "gmail", resourceType: "email", actionCategory: "send" }),
    ];

    let allEquivalent = true;
    const mismatches: string[] = [];

    for (const execution of representativeExecutions) {

      const staticDecision = evaluatePermission(execution);
      const subject = resolvePermissionSubject(execution);
      const registryDecision = evaluatePermissionFromRegistry(subject, execution, seededRules);

      const statusMatches = staticDecision.status === registryDecision.status;
      // 静的allowlist側のpolicyId(rule.id)は、seed migrationで
      // identifierへそのまま対応させているため、matchした場合は
      // 一致するはずである。unknown(policyId=null)の場合は両者とも
      // nullで一致する。
      const policyIdMatches = staticDecision.policyId === registryDecision.policyId;
      // reasonCodeはmatchした場合のみ厳密比較する。unmatched(unknown/
      // policyId=null)の場合、両evaluatorは意図的に異なるsentinel
      // reasonCode(no_matching_policy vs no_matching_registry_rule)を
      // 使う——「どちらのevaluatorが判定したか」を後から区別できる
      // ようにするための意図的な差異であり、統合すべき不一致ではない。
      const reasonMatches = staticDecision.policyId === null ? true : staticDecision.reasonCode === registryDecision.reasonCode;

      if (!statusMatches || !reasonMatches || !policyIdMatches) {
        allEquivalent = false;
        mismatches.push(
          `execution(actionCategory=${execution.actionCategory}, targetProvider=${execution.targetProvider}): ` +
          `static={${staticDecision.status},${staticDecision.reasonCode},${staticDecision.policyId}} vs ` +
          `registry={${registryDecision.status},${registryDecision.reasonCode},${registryDecision.policyId}}`
        );
      }

    }

    results.push(
      check(
        "[Seeded-registry equivalence] seed migrationと同内容のregistry ruleは、代表的なNotion/Slack execution全件で既存の静的allowlist evaluator(evaluatePermission())と同一のstatus/reasonCode/policyIdを返す",
        allEquivalent,
        mismatches.join(" | ")
      )
    );
  }

  return summarize("TACT Canonical Execution — Permission Registry Evaluator", results);

}
