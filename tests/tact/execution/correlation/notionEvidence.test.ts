// =========================
// TACT Canonical Execution — SOR-53 Notion Structural Evidence Regression
// =========================
//
// 対象: core/tact-execution/correlation/context.tsのextractNotionSignal()
// (resolveCorrelationContext()経由)と、stages/structural.tsの
// runNotionStructuralCorrelation()(runStructuralCorrelation()経由)。
// stages.test.tsの既存Slack testsと同じ方針(偽deps注入、実DB接続なし)。

import { resolveCorrelationContext } from "@tact/runs-core/tact-execution/correlation/context";
import {
  runStructuralCorrelation,
  type StructuralCorrelationDeps,
} from "@tact/runs-core/tact-execution/correlation/stages/structural";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { WorkReference } from "@tact/execution-contract";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeNotionExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: "connection-1",
    actorKind: "ai_agent",
    actorId: "principal-1",
    agentId: "agent-1",
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "mcp",
    sourceType: "sdk_callback",
    externalEventId: "invocation-1",
    adapterVersion: "notion-mcp-v1",
    sourceMetadata: null,
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "read",
    operation: "notion_read",
    resourceType: "notion_page",
    resourceIdentifier: "page-shared-doc",
    targetProvider: "notion",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: null,
    observedAt: "2026-09-22T00:00:00.000Z",
    persistedAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

// SOR-135 Phase 1 (Runs isolation): WorkReference projection, not Yolna's
// full Work entity.
function makeWork(overrides: Partial<WorkReference> = {}): WorkReference {
  return {
    id: "work-1",
    title: null,
    status: "running",
    conversationId: null,
    ...overrides,
  };
}

function throwingFindConversationLink(): StructuralCorrelationDeps["findConversationLink"] {
  return async () => { throw new Error("findConversationLink should not be called for a Notion-only context"); };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // ---- context.ts: extractNotionSignal() ----
  {
    const execution = makeNotionExecution();
    const context = resolveCorrelationContext(execution);

    results.push(check(
      "[context] a Notion execution (targetProvider=notion, resourceIdentifier set) yields a notion structural signal using only the sanitized resourceIdentifier",
      context.notion?.resourceRef === "page-shared-doc"
    ));
  }

  {
    // provider="mcp" alone (without targetProvider="notion") must not produce a signal —
    // this exercises the same targetProvider-vs-provider distinction SOR-51 established.
    const execution = makeNotionExecution({ targetProvider: "slack" });
    const context = resolveCorrelationContext(execution);

    results.push(check(
      "[context] targetProvider must be 'notion' specifically (provider='mcp' alone is not enough)",
      context.notion === undefined
    ));
  }

  {
    // CREATE_PAGE: resource ref unknown until the result comes back (SOR-51 design).
    const execution = makeNotionExecution({ resourceIdentifier: null, actionCategory: "create", operation: "notion_create_page" });
    const context = resolveCorrelationContext(execution);

    results.push(check(
      "[context / Required test 19] no resourceIdentifier (e.g. CREATE_PAGE) yields no structural signal — never guessed",
      context.notion === undefined
    ));
  }

  // ---- structural.ts: runNotionStructuralCorrelation() via runStructuralCorrelation() ----

  // ---- Required test 5: unique strong evidence -> CORRELATED(matched) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: throwingFindConversationLink(),
      listWorksForConversation: async () => { throw new Error("listWorksForConversation should not be called for a Notion-only context"); },
      listWorksForNotionResource: async (resourceRef) =>
        resourceRef === "page-shared-doc" ? [makeWork({ id: "work-notion-1" })] : [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeNotionExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check(
      "[Required test 5] a Notion resource ref matching exactly one Work's evidenceRefs -> matched (structural, notion_resource_match)",
      decision?.status === "matched" && decision.workId === "work-notion-1" && decision.reasonCode === "notion_resource_match"
    ));
  }

  // ---- Required test 6: multiple plausible candidates -> AMBIGUOUS(ambiguous) ----
  {
    const works = [makeWork({ id: "work-a" }), makeWork({ id: "work-b" })];

    const deps: StructuralCorrelationDeps = {
      findConversationLink: throwingFindConversationLink(),
      listWorksForConversation: async () => { throw new Error("should not be called"); },
      listWorksForNotionResource: async () => works,
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeNotionExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check(
      "[Required test 6] multiple Works sharing the same Notion resource ref -> ambiguous (never guess which one)",
      decision?.status === "ambiguous" && decision.workId === null &&
        JSON.stringify(decision.candidateWorkIds) === JSON.stringify(["work-a", "work-b"])
    ));
  }

  // ---- Required test 7: no safe candidate -> UNASSIGNED(このstageではnull、pipeline全体ではunresolvedへ) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: throwingFindConversationLink(),
      listWorksForConversation: async () => { throw new Error("should not be called"); },
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeNotionExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check(
      "[Required test 7] no Work references this Notion resource -> null (defers to the next stage, eventually unresolved)",
      decision === null
    ));
  }

  // ---- Required test 18: tenant isolation — Execution本人のuserIdだけが渡る ----
  {
    let capturedUserId: string | undefined;

    const deps: StructuralCorrelationDeps = {
      findConversationLink: throwingFindConversationLink(),
      listWorksForConversation: async () => { throw new Error("should not be called"); },
      listWorksForNotionResource: async (_resourceRef, userId) => {
        capturedUserId = userId;
        return [makeWork({ id: "work-tenant-1" })];
      },
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeNotionExecution({ userId: "user-tenant-77" });
    const context = resolveCorrelationContext(execution);
    await runStructuralCorrelation(execution, context, deps);

    results.push(check(
      "[Required test 18] listWorksForNotionResource() only ever receives the Execution's own userId, never another tenant's",
      capturedUserId === "user-tenant-77"
    ));
  }

  // ---- service role未設定 -> null(fail safe) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: throwingFindConversationLink(),
      listWorksForConversation: async () => { throw new Error("should not be called"); },
      listWorksForNotionResource: async () => { throw new Error("listWorksForNotionResource should not be called without a service role key"); },
      getServiceRoleKey: () => null,
    };

    const execution = makeNotionExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check(
      "[fail safe] service role未設定時はNotion resourceの照会自体を試みずnullを返す",
      decision === null
    ));
  }

  return summarize("TACT Canonical Execution — SOR-53 Notion Structural Evidence", results);
}
