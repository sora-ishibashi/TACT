// =========================
// SOR-138 Slice 1 — Two-path contract equivalence proof
// =========================
//
// Acceptance bar (SOR-138 issue text, "少なくとも2種類の異なるAgent/tool
// pathで同じcontractを検証"): prove that preflight() produces the same
// verdict semantics for equivalent Permission Registry rules regardless
// of which tool-shaped invocation calls it. These are contract-SHAPE
// tests, not provider integration tests — no @composio/core, no
// @slack/web-api, no Notion SDK, no LLM SDK is imported anywhere in this
// file (the forbidden-dependency scan in
// tests/tact/execution/runsCoreForbiddenDependency.test.ts independently
// enforces the same rule for packages/runs-core itself). "slack"/"notion"
// below are plain ExecutionProvider string values, exactly like any other
// adapter already normalizes into, never a provider SDK call.

import { randomUUID } from "node:crypto";
import { preflight, type PreflightDeps } from "@tact/runs-core/tact-execution/governance/contract";
import type { PreflightRequest } from "@tact/execution-contract";
import { makeFakeGovernanceStore, makeFakeRule } from "./governanceContractFakes";
import { check, summarize, type CheckResult } from "../../lib/check";

// Path A: a Slack-shaped tool invocation (an AI agent sending a message).
const slackShapedRequest: PreflightRequest = {
  invocationId: randomUUID(),
  userId: "user-1",
  actorKind: "ai_agent",
  agentId: "sales-agent",
  actionCategory: "send",
  operation: "slack.send_message",
  resourceType: "slack_channel",
  resourceIdentifier: "C_SALES",
  targetProvider: "slack",
  attemptedAt: "2026-10-04T00:00:00.000Z",
};

// Path B: a Notion-shaped tool invocation (the same kind of agent updating
// a page instead). Different provider/operation/resource vocabulary,
// same governance contract.
const notionShapedRequest: PreflightRequest = {
  invocationId: randomUUID(),
  userId: "user-1",
  actorKind: "ai_agent",
  agentId: "sales-agent",
  actionCategory: "update",
  operation: "notion.update_page",
  resourceType: "notion_page",
  resourceIdentifier: "page-42",
  targetProvider: "notion",
  attemptedAt: "2026-10-04T00:00:00.000Z",
};

function makeDeps(rules: Parameters<typeof makeFakeRule>[0][]): { deps: PreflightDeps; store: ReturnType<typeof makeFakeGovernanceStore> } {

  const store = makeFakeGovernanceStore();
  const builtRules = rules.map((overrides) => makeFakeRule(overrides));

  const deps: PreflightDeps = {
    createGovernanceInvocation: store.createGovernanceInvocation,
    listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
    appendGovernanceDecision: store.appendGovernanceDecision,
    listActivePermissionRulesForMatching: async () => builtRules,
    newDecisionId: () => randomUUID(),
    now: () => new Date("2026-10-04T00:00:01.000Z"),
  };

  return { deps, store };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // Equivalent rule shape on both paths: one specific allow rule matching
  // targetProvider+actionCategory, nothing else registered.
  {
    const slack = makeDeps([{ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "equivalent_allow" }]);
    const notion = makeDeps([{ targetProvider: "notion", actionCategory: "update", decision: "allowed", reasonCode: "equivalent_allow" }]);

    const slackOutcome = await preflight(slackShapedRequest, slack.deps);
    const notionOutcome = await preflight(notionShapedRequest, notion.deps);

    results.push(check(
      "[two-path/ALLOW] both tool paths go through the same preflight() and reach ALLOW for an equivalent allow rule",
      slackOutcome.status === "decided" && notionOutcome.status === "decided" &&
      slackOutcome.response.verdict === "ALLOW" && notionOutcome.response.verdict === "ALLOW"
    ));

    results.push(check(
      "[two-path/ALLOW] identical evaluatorVersion across both paths — one evaluator, no per-provider branch",
      slackOutcome.status === "decided" && notionOutcome.status === "decided" &&
      slackOutcome.response.evaluatorVersion === notionOutcome.response.evaluatorVersion
    ));

    results.push(check(
      "[two-path/ALLOW] identical reasonCode semantics for the equivalent rule",
      slackOutcome.status === "decided" && notionOutcome.status === "decided" &&
      slackOutcome.response.reasonCode === notionOutcome.response.reasonCode
    ));
  }

  // Equivalent rule shape, approval_required decision this time.
  {
    const slack = makeDeps([{ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "equivalent_approval" }]);
    const notion = makeDeps([{ targetProvider: "notion", actionCategory: "update", decision: "approval_required", reasonCode: "equivalent_approval" }]);

    const slackOutcome = await preflight(slackShapedRequest, slack.deps);
    const notionOutcome = await preflight(notionShapedRequest, notion.deps);

    results.push(check(
      "[two-path/APPROVAL_REQUIRED] both tool paths reach APPROVAL_REQUIRED for an equivalent approval rule",
      slackOutcome.status === "decided" && notionOutcome.status === "decided" &&
      slackOutcome.response.verdict === "APPROVAL_REQUIRED" && notionOutcome.response.verdict === "APPROVAL_REQUIRED"
    ));
  }

  // No registered rule on either path: both fail closed to UNKNOWN, never
  // to a provider-specific default.
  {
    const slack = makeDeps([]);
    const notion = makeDeps([]);

    const slackOutcome = await preflight(slackShapedRequest, slack.deps);
    const notionOutcome = await preflight(notionShapedRequest, notion.deps);

    results.push(check(
      "[two-path/UNKNOWN] an unregistered tool path fails closed to UNKNOWN identically, regardless of provider",
      slackOutcome.status === "decided" && notionOutcome.status === "decided" &&
      slackOutcome.response.verdict === "UNKNOWN" && notionOutcome.response.verdict === "UNKNOWN" &&
      slackOutcome.response.reasonCode === notionOutcome.response.reasonCode
    ));
  }

  // Cross-path isolation: a rule scoped to one provider must never decide
  // the other provider's invocation (no implicit wildcard fallthrough
  // across tool paths).
  {
    const { deps } = makeDeps([{ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "slack_only" }]);
    const notionOutcome = await preflight(notionShapedRequest, deps);

    results.push(check(
      "[two-path/isolation] a Slack-scoped rule does not leak an ALLOW into the Notion-shaped path",
      notionOutcome.status === "decided" && notionOutcome.response.verdict === "UNKNOWN"
    ));
  }

  return summarize("SOR-138 Slice 1 — two independent tool paths, one Preflight contract", results);

}
