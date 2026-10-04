// =========================
// SOR-142 — Standalone Runs App-Level Smoke (local-only harness)
// =========================
//
// Minimal truthful app-level proof for SOR-142 closeout: the standalone
// Runs Next.js app, already running against the disposable local
// products/yolna-runs/supabase/ instance, actually serves an authenticated
// read API using its EXISTING contracts (getCurrentUserContext() Bearer
// token boundary, listExecutionsForUser(), getExecutionCorrelationView()) —
// unchanged. This file adds no product behavior; it only drives the
// already-running dev server with two synthetic users it creates and
// deletes itself, the same disposable-instance convention dbRealityTest.ts
// already uses.
//
// Usage (dev server must already be running at APP_URL):
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   APP_URL=http://127.0.0.1:<port> npx tsx scripts/sor142AppSmokeTest.ts

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.APP_URL;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL) {
  console.error("[sor142AppSmoke] SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / APP_URL must all be set.");
  process.exit(1);
}

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

import { captureExecution, observeExecutionWorkCorrelation, type CanonicalExecution } from "@tact/runs-core/tact-execution";
import { postgresWorkProjectionWriter } from "../lib/projection/postgresProjectionAdapter";
import { check, summarize, type CheckResult } from "./lib/check";

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = "sor142-app-smoke-not-real-123";

async function createSyntheticUser(label: string): Promise<{ id: string; email: string; accessToken: string }> {

  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@runs-app-smoke.local`;

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`[sor142AppSmoke] failed to create synthetic user ${label}: ${error?.message}`);
  }

  const anon = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await anon.auth.signInWithPassword({ email, password: PASSWORD });

  if (signIn.error || !signIn.data.session) {
    throw new Error(`[sor142AppSmoke] failed to sign in synthetic user ${label}: ${signIn.error?.message}`);
  }

  return { id: data.user.id, email, accessToken: signIn.data.session.access_token };

}

async function deleteSyntheticUser(userId: string): Promise<void> {
  await adminClient.auth.admin.deleteUser(userId);
}

async function getJson(path: string, accessToken: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${APP_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- unauthenticated root/app routing does not crash ----
  const rootResponse = await fetch(`${APP_URL}/`);
  results.push(check("[1] root route responds without a server error", rootResponse.status < 500));

  const loginResponse = await fetch(`${APP_URL}/login`);
  results.push(check("[2] /login route is reachable without a server error", loginResponse.status < 500));

  const userA = await createSyntheticUser("app-smoke-a");
  const userB = await createSyntheticUser("app-smoke-b");

  try {

    const captureOutcome = await captureExecution({
      userId: userA.id,
      actorKind: "ai_agent",
      actorId: "agent-app-smoke-1",
      agentId: "agent-app-smoke-1",
      provider: "mcp",
      targetProvider: "notion",
      sourceType: "sdk_callback",
      externalEventId: `app-smoke-${Date.now()}`,
      adapterVersion: "app-smoke-v1",
      actionCategory: "update",
      operation: "notion_update_page",
      resourceType: "notion_page",
      resourceIdentifier: "page-app-smoke-1",
    } as never);

    if (captureOutcome.status !== "captured") {
      throw new Error(`captureExecution did not succeed: ${JSON.stringify(captureOutcome)}`);
    }

    const execution: CanonicalExecution = captureOutcome.execution;

    await postgresWorkProjectionWriter.upsertWork({
      externalWorkId: crypto.randomUUID(),
      userId: userA.id,
      title: "App Smoke Work",
      status: "running",
      conversationReference: null,
    });

    await observeExecutionWorkCorrelation(execution);

    // ---- own data visibility: User A reads their own captured execution via the existing authenticated read API ----
    const activityAsA = await getJson("/api/tact/runs/activity", userA.accessToken);
    results.push(check("[3] GET /api/tact/runs/activity as User A returns 200", activityAsA.status === 200));
    const itemsAsA = (activityAsA.body as { items?: Array<{ executionId?: string }> } | null)?.items ?? [];
    results.push(check("[4] User A's own captured execution is visible in their own Activity read", itemsAsA.some((item) => item.executionId === execution.id)));

    // ---- cross-user denial: User B's own Activity read never contains User A's execution ----
    const activityAsB = await getJson("/api/tact/runs/activity", userB.accessToken);
    results.push(check("[5] GET /api/tact/runs/activity as User B returns 200 (own, empty, list)", activityAsB.status === 200));
    const itemsAsB = (activityAsB.body as { items?: Array<{ executionId?: string }> } | null)?.items ?? [];
    results.push(check("[6] User B's Activity read contains none of User A's executions", !itemsAsB.some((item) => item.executionId === execution.id)));

    // ---- cross-user denial / not-found on a by-id resource: User B cannot read User A's correlation detail ----
    const correlationAsB = await getJson(`/api/tact/runs/execution/${execution.id}/correlation`, userB.accessToken);
    results.push(check("[7] GET .../execution/{id}/correlation as User B returns 404 (not-found, never leaked)", correlationAsB.status === 404));

    const correlationAsA = await getJson(`/api/tact/runs/execution/${execution.id}/correlation`, userA.accessToken);
    results.push(check("[8] GET .../execution/{id}/correlation as User A (owner) returns 200", correlationAsA.status === 200));

    // ---- unauthenticated request is rejected, not silently allowed ----
    const unauthResponse = await fetch(`${APP_URL}/api/tact/runs/activity`);
    results.push(check("[9] GET /api/tact/runs/activity without a token returns 401", unauthResponse.status === 401));

  } finally {

    await deleteSyntheticUser(userA.id);
    await deleteSyntheticUser(userB.id);

  }

  return summarize("SOR-142 — Standalone Runs App-Level Smoke", results);

}

run()
  .then(({ fail }) => {
    if (fail > 0) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error("[sor142AppSmoke] FAILED WITH EXCEPTION", error);
    process.exitCode = 1;
  });
