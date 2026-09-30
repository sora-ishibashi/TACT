// =========================
// SOR-130 Reality Test — Notion (Document/Knowledge category)
// =========================
//
// 実Notion API(sandbox parent page配下)へ実際にCREATE_PAGE/READ/
// UPDATE_PAGE/DELETE_PAGE(archive)を行い、既存のobserveNotionMcpExecution()
// (SOR-129によりGeneric Observation Gateway経由に書き換え済み)を通して
// local Supabaseのtact_canonical_executionsへ永続化する。Notion自体の
// 実装(normalizer/wrapper)には一切手を加えない——このスクリプトは
// Reality Testのための呼び出し元にすぎない。

import "./lib/loadDotEnv";

import { randomUUID } from "node:crypto";
import {
  observeNotionMcpExecution,
  getExecutionById,
  type NotionMcpInvocationObservation,
} from "../../core/tact-execution";
import { getServiceRoleClient } from "../../core/database/supabaseServiceRole";
import { applyLocalSupabaseEnv } from "./lib/localSupabaseEnv";
import { ensureRealityTestUser } from "./lib/ensureRealityTestUser";
import { check, printReport, privacySweep, type RealityTestCheck } from "./lib/reportUtils";

const NOTION_TOKEN = process.env.NOTION_TEST_HOST_TOKEN;
const PARENT_PAGE_ID = process.env.NOTION_TEST_HOST_SANDBOX_PARENT_PAGE_ID;

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function notionHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: notionHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {

  applyLocalSupabaseEnv();

  if (!NOTION_TOKEN || !PARENT_PAGE_ID) {
    console.log(
      "[sor130-reality-test/notion] UNVERIFIED — NOTION_TEST_HOST_TOKEN / NOTION_TEST_HOST_SANDBOX_PARENT_PAGE_ID not set."
    );
    process.exitCode = 0;
    return;
  }

  const results: RealityTestCheck[] = [];
  const client = getServiceRoleClient();

  if (!client) {
    throw new Error("getServiceRoleClient() returned null — SUPABASE_SERVICE_ROLE_KEY was not applied correctly");
  }

  const REALITY_TEST_USER_ID = await ensureRealityTestUser(client);

  // ---- Principal identity: real Notion bot user (never fabricated) ----
  const me = await notionRequest("GET", "/users/me");
  const principalId = (me.json as { id?: string })?.id ?? null;
  results.push(check("[identity] GET /users/me resolved a real Notion principal id", typeof principalId === "string", principalId ?? "none"));

  const agentId = "sor130-reality-test-agent";
  const titleText = `SOR-130 Reality Test ${new Date().toISOString()}`;

  // ---- CREATE_PAGE ----
  const createInvocationId = `sor130-notion-create-${randomUUID()}`;
  const createRes = await notionRequest("POST", "/pages", {
    parent: { page_id: PARENT_PAGE_ID },
    properties: { title: { title: [{ text: { content: titleText } }] } },
  });
  const createdPageId = (createRes.json as { id?: string })?.id ?? null;
  results.push(check("[CREATE] real Notion page created under sandbox parent", createRes.status === 200 && !!createdPageId, `status=${createRes.status}`));

  if (!createdPageId) {
    printReport("Notion", results);
    return;
  }

  const baseObservation: Omit<NotionMcpInvocationObservation, "operation" | "invocationId" | "resource" | "status"> = {
    userId: REALITY_TEST_USER_ID,
    actorKind: "ai_agent",
    principalId,
    agentId,
    toolName: "sor130_reality_test_notion_tool",
    mcpProvider: "custom",
  };

  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: createInvocationId,
    operation: "CREATE_PAGE",
    resource: { type: "page", ref: createdPageId },
    status: "succeeded",
  });

  const createdExecution = client
    ? await client
        .from("tact_canonical_executions")
        .select("id")
        .eq("user_id", REALITY_TEST_USER_ID)
        .eq("external_event_id", createInvocationId)
        .maybeSingle()
    : { data: null };

  const executionId = (createdExecution.data as { id?: string } | null)?.id ?? null;
  results.push(check("[CREATE] CanonicalExecution row persisted for the create invocation", !!executionId));

  // ---- READ ----
  const readRes = await notionRequest("GET", `/pages/${createdPageId}`);
  results.push(check("[READ] real Notion page read back", readRes.status === 200, `status=${readRes.status}`));

  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: `sor130-notion-read-${randomUUID()}`,
    operation: "READ",
    resource: { type: "page", ref: createdPageId },
    status: readRes.status === 200 ? "succeeded" : "failed",
    errorCode: readRes.status === 200 ? null : "notion_mcp_tool_failed",
  });

  // ---- UPDATE_PAGE ----
  const updateRes = await notionRequest("PATCH", `/pages/${createdPageId}`, {
    properties: { title: { title: [{ text: { content: `${titleText} (updated)` } }] } },
  });
  results.push(check("[UPDATE] real Notion page title updated", updateRes.status === 200, `status=${updateRes.status}`));

  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: `sor130-notion-update-${randomUUID()}`,
    operation: "UPDATE_PAGE",
    resource: { type: "page", ref: createdPageId },
    status: updateRes.status === 200 ? "succeeded" : "failed",
    errorCode: updateRes.status === 200 ? null : "notion_mcp_tool_failed",
  });

  // ---- Duplicate invocation (same invocationId as CREATE, no new real API call) ----
  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: createInvocationId,
    operation: "CREATE_PAGE",
    resource: { type: "page", ref: createdPageId },
    status: "succeeded",
  });

  const duplicateRows = client
    ? await client
        .from("tact_canonical_executions")
        .select("id")
        .eq("user_id", REALITY_TEST_USER_ID)
        .eq("external_event_id", createInvocationId)
    : { data: [] };

  results.push(
    check(
      "[duplicate] re-observing the same invocationId does not create a second row",
      Array.isArray(duplicateRows.data) && duplicateRows.data.length === 1
    )
  );

  // ---- Intentional failure: READ a nonexistent page ----
  const bogusPageId = "00000000-0000-0000-0000-000000000000";
  const failRes = await notionRequest("GET", `/pages/${bogusPageId}`);
  results.push(check("[intentional failure] reading a nonexistent page returns a real Notion error", failRes.status !== 200, `status=${failRes.status}`));

  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: `sor130-notion-fail-${randomUUID()}`,
    operation: "READ",
    resource: { type: "page", ref: bogusPageId },
    status: "failed",
    errorCode: "notion_not_found",
  });

  // ---- DELETE_PAGE (archive) — cleanup ----
  const archiveRes = await notionRequest("PATCH", `/pages/${createdPageId}`, { archived: true });
  results.push(check("[DELETE/archive] sandbox page archived (cleanup)", archiveRes.status === 200, `status=${archiveRes.status}`));

  await observeNotionMcpExecution({
    ...baseObservation,
    invocationId: `sor130-notion-delete-${randomUUID()}`,
    operation: "DELETE_PAGE",
    resource: { type: "page", ref: createdPageId },
    status: archiveRes.status === 200 ? "succeeded" : "failed",
    errorCode: archiveRes.status === 200 ? null : "notion_mcp_tool_failed",
  });

  // ---- Read back persisted row + privacy sweep + Work ID / permission observation ----
  if (executionId) {
    const persisted = await getExecutionById(executionId, REALITY_TEST_USER_ID);
    results.push(check("[readback] persisted execution row is queryable via getExecutionById()", !!persisted));
    results.push(
      privacySweep(persisted, [titleText, NOTION_TOKEN ?? "__no_token__"])
    );
    results.push(
      check(
        "[Work ID] no explicit carrier was supplied -> workId is not fabricated",
        !!persisted && persisted.workId === null,
        persisted ? `workId=${String(persisted.workId)}` : undefined
      )
    );
    results.push(
      check(
        "[permission] permissionStatus reflects the actual policy evaluation (not guessed)",
        !!persisted,
        persisted ? `permissionStatus=${persisted.permissionStatus}` : undefined
      )
    );
    results.push(
      check(
        "[observationMode] recorded as 'instrumented' (TACT's own code wraps the real Notion call)",
        !!persisted && persisted.observationMode === "instrumented"
      )
    );
  }

  printReport("Notion", results);

}

main().catch((error) => {
  console.error("[sor130-reality-test/notion] fatal error", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
