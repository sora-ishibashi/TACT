// SOR-148 — Local, disposable Supabase proof for correlation RPC ACLs.
//
// This script requires the product-local Supabase instance only. It creates
// synthetic users and records, then removes them at the end. It never reads
// or writes any hosted project.

import { createClient } from "@supabase/supabase-js";
import { check, summarize, type CheckResult } from "./lib/check";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  console.error(
    "[rpcExecuteSecurityTest] SUPABASE_URL, SUPABASE_ANON_KEY, and " +
      "SUPABASE_SERVICE_ROLE_KEY must target the disposable local Runs instance."
  );
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const applyArgs = (executionId: string, userId: string, workId: string) => ({
  p_execution_id: executionId,
  p_user_id: userId,
  p_status: "matched",
  p_method: "explicit",
  p_reason_code: "sor_148_local_acl_test",
  p_correlator_version: "sor-148-local-v1",
  p_decision_fingerprint: crypto.randomUUID(),
  p_target_work_id: workId,
  p_confidence: 1,
  p_candidate_work_ids: [workId],
  p_metadata: { synthetic: true },
});

function isPermissionDenied(error: { message?: string } | null): boolean {
  return Boolean(error && /permission denied|not authorized|42501/i.test(error.message ?? ""));
}

async function createUser(label: string) {
  const email = `${label}-${crypto.randomUUID()}@runs-rpc-test.local`;
  const password = "local-rpc-security-test-123";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`[rpcExecuteSecurityTest] create user failed: ${error?.message}`);
  }

  return { id: data.user.id, email, password };
}

async function insertExecution(userId: string, externalEventId: string) {
  const { data, error } = await admin
    .from("tact_canonical_executions")
    .insert({
      user_id: userId,
      actor_kind: "service",
      actor_id: "sor-148-local-test",
      provider: "mcp",
      source_type: "manual_report",
      external_event_id: externalEventId,
      adapter_version: "sor-148-local-v1",
      action_category: "update",
      operation: "local_rpc_acl_test",
      observed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`[rpcExecuteSecurityTest] insert execution failed: ${error?.message}`);
  }

  return data.id as string;
}

async function insertWorkProjection(userId: string) {
  const externalWorkId = crypto.randomUUID();
  const { error } = await admin.from("tact_runs_work_projection").insert({
    external_work_id: externalWorkId,
    user_id: userId,
    title: "SOR-148 local ACL test",
    status: "running",
  });

  if (error) {
    throw new Error(`[rpcExecuteSecurityTest] insert work projection failed: ${error.message}`);
  }

  return externalWorkId;
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const userA = await createUser("user-a");
  const userB = await createUser("user-b");

  try {
    const executionId = await insertExecution(userA.id, `sor-148-${crypto.randomUUID()}`);
    const workId = await insertWorkProjection(userA.id);

    const { error: anonApplyError } = await anon.rpc(
      "apply_execution_work_correlation",
      applyArgs(executionId, userA.id, workId)
    );
    results.push(check("[ACL] anon REST RPC call is rejected", isPermissionDenied(anonApplyError)));

    const authenticated = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await authenticated.auth.signInWithPassword({
      email: userA.email,
      password: userA.password,
    });
    if (signInError) {
      throw new Error(`[rpcExecuteSecurityTest] authenticated sign-in failed: ${signInError.message}`);
    }

    const { error: authenticatedApplyError } = await authenticated.rpc(
      "apply_execution_work_correlation",
      applyArgs(executionId, userA.id, workId)
    );
    results.push(check("[ACL] authenticated REST RPC call is rejected", isPermissionDenied(authenticatedApplyError)));

    const { data: applyResult, error: serviceApplyError } = await admin.rpc(
      "apply_execution_work_correlation",
      applyArgs(executionId, userA.id, workId)
    );
    results.push(check(
      "[ACL] service_role applies an owned correlation",
      !serviceApplyError && applyResult?.outcome === "correlated"
    ));

    const { data: crossUserResult, error: crossUserError } = await admin.rpc(
      "reclassify_execution_work",
      {
        p_execution_id: executionId,
        p_user_id: userB.id,
        p_expected_previous_work_id: workId,
        p_new_work_id: null,
        p_changed_by_actor_kind: "service",
        p_changed_by_actor_id: "sor-148-local-test",
        p_reason_code: "cross_user_negative",
        p_metadata: { synthetic: true },
      }
    );
    results.push(check(
      "[Isolation] service_role cannot reclassify User A execution with User B identity",
      !crossUserError && crossUserResult?.outcome === "execution_not_found"
    ));

    const { data: reclassifyResult, error: serviceReclassifyError } = await admin.rpc(
      "reclassify_execution_work",
      {
        p_execution_id: executionId,
        p_user_id: userA.id,
        p_expected_previous_work_id: workId,
        p_new_work_id: null,
        p_changed_by_actor_kind: "service",
        p_changed_by_actor_id: "sor-148-local-test",
        p_reason_code: "service_role_positive",
        p_metadata: { synthetic: true },
      }
    );
    results.push(check(
      "[ACL] service_role reclassification path remains available",
      !serviceReclassifyError && reclassifyResult?.outcome === "reclassified"
    ));
  } finally {
    await admin.auth.admin.deleteUser(userA.id);
    await admin.auth.admin.deleteUser(userB.id);
  }

  return summarize("Yolna Runs — SOR-148 correlation RPC ACL test", results);
}

run()
  .then(({ fail }) => {
    if (fail > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("[rpcExecuteSecurityTest] FAILED WITH EXCEPTION", error);
    process.exitCode = 1;
  });
