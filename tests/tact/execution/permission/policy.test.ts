// =========================
// TACT Canonical Execution — Permission Policy Regression (SOR-51)
// =========================
//
// 対象: core/tact-execution/permission/policy.tsのresolvePermissionPolicy()
// (純粋関数、DBアクセスなし)。SOR-51 Tests要件の
// 「exact policy match → allowed」「explicit deny → denied」
// 「no policy → unknown(=undefined)」「wrong actor/provider/action/
// resource → unknown(=undefined)」を検証する。

import { resolvePermissionPolicy, listPermissionPolicyRules, matchesRule } from "../../../../core/tact-execution/permission/policy";
import type { PermissionPolicyRule, PermissionSubject } from "../../../../core/tact-execution/permission/types";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
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
    providerOccurredAt: null,
    observedAt: "2026-09-20T00:00:00.000Z",
    persistedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: exact policy match -> allowed (human slack mention) ----
  {
    const subject: PermissionSubject = { kind: "human", id: "U123" };
    const rule = resolvePermissionPolicy(subject, makeExecution());

    results.push(
      check(
        "[Test1] human + slack + slack_message + create は登録済みruleにmatchしallowedを返す",
        rule?.decision === "allowed" && rule.id === "human-slack-mention-allowed"
      )
    );
  }

  // ---- Test2: explicit deny (ai_agent + slack message SEND) ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "agent-1" };
    const execution = makeExecution({ actorKind: "ai_agent", resourceType: "slack_message", actionCategory: "send" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(
      check(
        "[Test2] ai_agent + slack + slack_message + send は明示的にdeniedを返す",
        rule?.decision === "denied" && rule.id === "ai-agent-slack-message-send-denied"
      )
    );
  }

  // ---- Test1(Case1相当): ai_agent + slack channel READ -> allowed ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "agent-1" };
    const execution = makeExecution({ actorKind: "ai_agent", resourceType: "slack_channel", actionCategory: "read" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(
      check(
        "[Case1] ai_agent + slack + slack_channel + read は登録済みruleにmatchしallowedを返す",
        rule?.decision === "allowed" && rule.id === "ai-agent-slack-channel-read-allowed"
      )
    );
  }

  // ---- Test3: no policy -> undefined(呼び出し元がunknownへ倒す) ----
  {
    const subject: PermissionSubject = { kind: "service", id: "svc-1" };
    const execution = makeExecution({ actorKind: "service", provider: "notion", resourceType: "page", actionCategory: "update" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(check("[Test3] 未登録の組み合わせはundefinedを返す(unknownへ倒す判断はEvaluator側)", rule === undefined));
  }

  // ---- Test4: wrong actor -> undefined ----
  {
    const subject: PermissionSubject = { kind: "connector", id: "conn-1" };
    const rule = resolvePermissionPolicy(subject, makeExecution());

    results.push(check("[Test4] 登録済みruleとactor kindが一致しない場合はundefined", rule === undefined));
  }

  // ---- Test5: wrong provider -> undefined ----
  {
    const subject: PermissionSubject = { kind: "human", id: "U123" };
    const execution = makeExecution({ provider: "gmail" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(check("[Test5] providerが一致しない場合はundefined", rule === undefined));
  }

  // ---- Test6: wrong action -> undefined ----
  {
    const subject: PermissionSubject = { kind: "human", id: "U123" };
    const execution = makeExecution({ actionCategory: "delete" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(check("[Test6] actionCategoryが一致しない場合はundefined", rule === undefined));
  }

  // ---- Test7: wrong resource -> undefined ----
  {
    const subject: PermissionSubject = { kind: "human", id: "U123" };
    const execution = makeExecution({ resourceType: "slack_channel" });
    const rule = resolvePermissionPolicy(subject, execution);

    results.push(check("[Test7] resourceTypeが一致しない場合はundefined", rule === undefined));
  }

  // ---- 参考: allowlist自体がallowed/deniedを両方含む ----
  {
    const rules = listPermissionPolicyRules();

    results.push(
      check(
        "[Ref] 初期allowlistはallowed/denied双方の例を含む",
        rules.some((r) => r.decision === "allowed") && rules.some((r) => r.decision === "denied")
      )
    );
  }

  // =========================
  // SOR-51 M-0(Notion Permission Registry)
  // =========================

  function makeNotionExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
    return makeExecution({
      actorKind: "ai_agent",
      actorId: "principal-1",
      agentId: "agent-1",
      connectionId: "connection-1",
      provider: "mcp",
      sourceType: "sdk_callback",
      targetProvider: "notion",
      resourceType: "notion_page",
      // makeExecution()の既定(Slack向け)actionCategory="create"を
      // 継承しないよう、Notion向けの妥当な既定へ上書きする(overridesが
      // 個別に指定すればそちらが優先される)。
      actionCategory: "read",
      operation: "notion_read",
      ...overrides,
    });
  }

  // ---- targetProvider fix: MCP-observed Notion executions have
  // provider="mcp"(not "notion"), so matching must use targetProvider. ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };
    const readRule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "read", operation: "notion_read" }));
    const createRule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "create", operation: "notion_create_page" }));
    const updateRule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "update", operation: "notion_update_page" }));
    const deleteRule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }));

    results.push(check(
      "[SOR-51 M-0] provider=mcp/targetProvider=notion matches the Notion M-0 matrix (READ/CREATE_PAGE allowed, UPDATE_PAGE approval_required, DELETE_PAGE denied)",
      readRule?.decision === "allowed" &&
        createRule?.decision === "allowed" &&
        updateRule?.decision === "approval_required" &&
        deleteRule?.decision === "denied"
    ));
  }

  // ---- targetProvider is additive: an unrelated targetProvider="notion" rule
  // must not start matching a Slack-observed execution (provider="slack",
  // targetProvider default "slack" in the base fixture). ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };
    const slackExecution = makeExecution({ actorKind: "ai_agent", resourceType: "slack_channel", actionCategory: "read" });
    const rule = resolvePermissionPolicy(subject, slackExecution);

    results.push(check(
      "[SOR-51 M-0] adding targetProvider-scoped Notion rules does not change matching for existing provider-only Slack rules",
      rule?.id === "ai-agent-slack-channel-read-allowed"
    ));
  }

  // ---- requiresKnownActorId: unknown principal must not match ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: null };
    const rule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "read", operation: "notion_read" }));

    results.push(check(
      "[SOR-51 M-0 / Required test 6] unknown principal (actorId=null) does not match the Notion READ rule, even though agentId is known",
      rule === undefined
    ));
  }

  // ---- requiresKnownAgentId: unknown agent must not match, only where required ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };
    const notionExecution = makeNotionExecution({ actionCategory: "read", operation: "notion_read", agentId: null });
    const notionRule = resolvePermissionPolicy(subject, notionExecution);

    const slackExecution = makeExecution({ actorKind: "ai_agent", resourceType: "slack_channel", actionCategory: "read", agentId: null });
    const slackRule = resolvePermissionPolicy(subject, slackExecution);

    results.push(check(
      "[SOR-51 M-0 / Required test 7] unknown agent (agentId=null) fails the Notion rule (requiresKnownAgentId) " +
        "but does not affect the Slack rule (which does not require it)",
      notionRule === undefined && slackRule?.id === "ai-agent-slack-channel-read-allowed"
    ));
  }

  // ---- unknown action: Notion actionCategory outside the M-0 matrix -> undefined ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };
    const rule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "share", operation: "notion_share" }));

    results.push(check(
      "[SOR-51 M-0 / Required test 5] an action outside the M-0 matrix (e.g. share) does not match any Notion rule",
      rule === undefined
    ));
  }

  // ---- connection/account scope: default (unset) ignores connection; an
  // explicit scope on a rule is the only thing that can turn a wrong
  // connection into a non-match. ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };

    const unscopedExecution = makeNotionExecution({ actionCategory: "read", operation: "notion_read", connectionId: "unexpected-connection" });
    const unscopedRule = resolvePermissionPolicy(subject, unscopedExecution);

    const scopedRule: PermissionPolicyRule = {
      id: "test-only-connection-scoped-rule",
      subjectKind: "ai_agent",
      provider: "*",
      targetProvider: "notion",
      resourceType: "*",
      actionCategory: "read",
      decision: "allowed",
      reasonCode: "test_only_connection_scoped",
      connectionId: "connection-1",
    };
    const matchesRightConnection = matchesRule(scopedRule, subject, makeNotionExecution({ connectionId: "connection-1" }));
    const matchesWrongConnection = matchesRule(scopedRule, subject, makeNotionExecution({ connectionId: "wrong-connection" }));

    results.push(check(
      "[SOR-51 M-0 / Required test 8] an unset connection scope ignores connectionId (still MATCH), " +
        "while an explicitly connection-scoped rule only matches its own connectionId",
      unscopedRule !== undefined &&
        matchesRightConnection === true &&
        matchesWrongConnection === false
    ));
  }

  // ---- Work ID null: policy resolution does not depend on workId at all ----
  {
    const subject: PermissionSubject = { kind: "ai_agent", id: "principal-1" };
    const rule = resolvePermissionPolicy(subject, makeNotionExecution({ actionCategory: "read", operation: "notion_read", workId: null }));

    results.push(check(
      "[SOR-51 M-0 / Required test 13] policy resolution works the same whether workId is null (Work correlation is never awaited)",
      rule?.decision === "allowed"
    ));
  }

  return summarize("TACT Canonical Execution — Permission Policy", results);

}
