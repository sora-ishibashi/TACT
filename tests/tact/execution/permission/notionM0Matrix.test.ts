// =========================
// TACT Canonical Execution — SOR-51 M-0 Notion Permission Matrix
// =========================
//
// 対象: core/tact-execution/permission/evaluatePermission() +
// toCanonicalPermissionResult()の組み合わせ、実際にNotion MCP adapter
// (core/tact-execution/adapters/notion/normalizeNotionMcpExecution.ts)
// が生成するCanonicalExecutionの形に沿ったfixtureで、SOR-51指示の
// 「M-0 Test Permission Matrix」の期待結果をそのまま検証する
// (READ/CREATE_PAGE allowed->MATCH、UPDATE_PAGE approval_required->
// APPROVAL_REQUIRED、DELETE_PAGE denied->MISMATCH)。
//
// 内部vocabulary(allowed/denied/approval_required/unknown)自体の
// matching規則はpolicy.test.ts/evaluate.test.tsが検証する——このfileは
// 「product-facing canonical output」という契約そのものを、実際に
// M-0が要求する4ケース+周辺のfail-safeケースについて確認する。

import { evaluatePermission } from "../../../../core/tact-execution/permission/evaluate";
import { toCanonicalPermissionResult, type CanonicalPermissionResult } from "../../../../core/tact-execution/permission/canonicalResult";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeNotionExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
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
    actionCategory: "read",
    operation: "notion_read",
    resourceType: "notion_page",
    resourceIdentifier: "page-1",
    targetProvider: "notion",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T00:00:00.000Z",
    persistedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function canonicalFor(overrides: Partial<CanonicalExecution>): CanonicalPermissionResult {
  return toCanonicalPermissionResult(evaluatePermission(makeNotionExecution(overrides)).status);
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // ---- M-0 Test Permission Matrix (section "M-0 Test Permission Matrix") ----
  results.push(check(
    "[Required test 1] READ (allowed) -> canonical MATCH",
    canonicalFor({ actionCategory: "read", operation: "notion_read" }) === "MATCH"
  ));

  results.push(check(
    "[Required test 2] CREATE_PAGE (allowed) -> canonical MATCH",
    canonicalFor({ actionCategory: "create", operation: "notion_create_page" }) === "MATCH"
  ));

  results.push(check(
    "[Required test 3] UPDATE_PAGE (approval_required) -> canonical APPROVAL_REQUIRED",
    canonicalFor({ actionCategory: "update", operation: "notion_update_page" }) === "APPROVAL_REQUIRED"
  ));

  results.push(check(
    "[Required test 4] DELETE_PAGE (forbidden) -> canonical MISMATCH",
    canonicalFor({ actionCategory: "delete", operation: "notion_delete_page" }) === "MISMATCH"
  ));

  // ---- Required test 5: unknown action -> UNKNOWN ----
  results.push(check(
    "[Required test 5] an action outside the M-0 matrix (share) -> canonical UNKNOWN",
    canonicalFor({ actionCategory: "share", operation: "notion_share" }) === "UNKNOWN"
  ));

  // ---- Required test 6: unknown principal -> UNKNOWN ----
  results.push(check(
    "[Required test 6] unknown principal (actorId=null) -> canonical UNKNOWN, never guessed as MATCH",
    canonicalFor({ actionCategory: "read", operation: "notion_read", actorId: null }) === "UNKNOWN"
  ));

  // ---- Required test 7: unknown agent -> UNKNOWN when required ----
  results.push(check(
    "[Required test 7] unknown agent (agentId=null) -> canonical UNKNOWN for a Notion action that requires a known agent",
    canonicalFor({ actionCategory: "read", operation: "notion_read", agentId: null }) === "UNKNOWN"
  ));

  // ---- Required test 8: wrong connection/account -> UNKNOWN or MISMATCH
  // only if explicitly defined. The M-0 matrix itself is not
  // connection-scoped, so a differing connectionId does not change the
  // action-based result (still MATCH) — the explicit-scope MISMATCH case
  // is covered at the matchesRule() primitive level in policy.test.ts. ----
  results.push(check(
    "[Required test 8] an unrecognised connectionId does not silently produce MATCH via a different, unintended rule " +
      "(the M-0 matrix's action-based result is unaffected because no rule scopes on connection)",
    canonicalFor({ actionCategory: "read", operation: "notion_read", connectionId: "unexpected-connection" }) === "MATCH"
  ));

  // ---- Required test 13: Work ID null -> evaluation still works ----
  results.push(check(
    "[Required test 13] evaluation works the same when workId is null (Work correlation, SOR-53, is never awaited)",
    canonicalFor({ actionCategory: "read", operation: "notion_read", workId: null }) === "MATCH"
  ));

  // ---- Section5: Do not flatten approval into denied ----
  {
    const approvalRequired = evaluatePermission(makeNotionExecution({ actionCategory: "update", operation: "notion_update_page" }));
    const denied = evaluatePermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }));

    results.push(check(
      "[Section5] approval_required and denied are distinct internal statuses (never collapsed into each other)",
      approvalRequired.status === "approval_required" && denied.status === "denied"
    ));
  }

  return summarize("TACT Canonical Execution — SOR-51 M-0 Notion Permission Matrix", results);
}
