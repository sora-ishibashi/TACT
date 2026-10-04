/* Local-only SOR-8C Postgres acceptance. Never targets hosted Supabase. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getExecutionById } from "@tact/runs-core/tact-execution";
import {
  recordDownstreamPermissionEvidence,
  listDownstreamPermissionEvidenceForExecution,
} from "@tact/runs-core/tact-execution/downstreamPermission/store";
import { compareDownstreamPermissionEvidence } from "@tact/runs-core/tact-execution/downstreamPermission/compare";
import type { DownstreamPermissionEvidenceInput } from "@tact/runs-core/tact-execution/downstreamPermission/types";
import type { PermissionDecision } from "@tact/runs-core/tact-execution/permission/types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
}

const url = requireEnv("SUPABASE_URL");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = requireEnv("SUPABASE_ANON_KEY");

// getServiceRoleClient() reads these exact env var names (same fixture
// pattern as sor8bGovernanceDbAcceptance.ts / sor8aTelemetrySecurityTest.ts).
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const TABLE = "tact_execution_downstream_permission_evidence";
const now = "2027-01-01T00:00:00.000Z";

const checks: string[] = [];
function check(name: string, value: unknown) {
  assert.ok(value, name);
  checks.push(name);
}

// Independent of checks.length by construction: this is the actual count of
// check() call sites in this file as of this change (30 inline in main() +
// 7 in schemaIntrospection() + 1 in migration00013Unchanged() + 1 in
// noPublicRouteIntroduced() = 39 — more than the spec's minimum list of 35,
// because several spec items carry extra named sub-checks). Asserting
// checks.length against this fixed constant, rather than printing
// `${checks.length}/${checks.length}`, means a future accidental removal of
// a check fails loudly here instead of silently reporting a self-referential
// ratio that can never be wrong.
const EXPECTED_CHECKS = 39;

function sql(query: string): string {
  return execFileSync("docker", ["exec", "supabase_db_yolna-runs", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", query], { encoding: "utf8" }).trim();
}

async function createUser(label: string) {
  const email = `sor8c-${label}-${randomUUID()}@example.invalid`;
  const password = "sor8c-local-only-password";
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!result.data.user) throw new Error(result.error?.message ?? "user creation failed");
  return { id: result.data.user.id, email, password };
}

async function createExecution(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await admin
    .from("tact_canonical_executions")
    .insert({
      user_id: userId,
      actor_kind: "ai_agent",
      agent_id: "agent-1",
      provider: "mcp",
      target_provider: "notion",
      connection_id: null,
      source_type: "manual_report",
      external_event_id: randomUUID(),
      adapter_version: "sor8c-local-v1",
      action_category: "update",
      operation: "notion_update_page",
      resource_type: "notion_page",
      resource_identifier: "page-1",
      observed_at: now,
      provider_occurred_at: now,
      ...overrides,
    })
    .select("id")
    .single();
  if (!row.data) throw new Error(row.error?.message ?? "execution fixture creation failed");
  return row.data.id as string;
}

function evidenceInput(executionId: string, userId: string, overrides: Partial<DownstreamPermissionEvidenceInput> = {}): DownstreamPermissionEvidenceInput {
  return {
    id: randomUUID(),
    userId,
    executionId,
    targetProvider: "notion",
    connectionId: null,
    subjectKind: "ai_agent",
    subjectId: null,
    agentId: "agent-1",
    actionCategory: "update",
    operation: "notion_update_page",
    resourceType: "notion_page",
    resourceIdentifier: "page-1",
    permissionState: "allowed",
    sourceType: "provider_acl",
    sourceIdentifier: null,
    authorityLevel: "AUTHORITATIVE",
    trustLevel: "INTERNAL",
    observedAt: now,
    evidenceSnapshot: null,
    ...overrides,
  };
}

function decision(status: PermissionDecision["status"]): PermissionDecision {
  return { executionId: "n/a", status, reasonCode: "local_test", policyId: "policy-1", evaluatorVersion: "sor8c-local-v1", evaluatedAt: now };
}

function schemaIntrospection() {

  const tableExists = sql(`select count(*) from pg_tables where schemaname='public' and tablename='${TABLE}'`);
  check("schema table exists", tableExists === "1");

  const fks = sql(
    `select string_agg(pg_get_constraintdef(oid), E'\\n') from pg_constraint where contype='f' and conrelid='public.${TABLE}'::regclass`
  );
  check(
    "29 composite tenant FK exists",
    fks.includes("FOREIGN KEY (execution_id, user_id)") && fks.includes("tact_canonical_executions(id, user_id)")
  );
  const fkCount = (fks.match(/FOREIGN KEY/g) ?? []).length;
  check("33 no provider credential introduced (only the two expected FKs)", fkCount === 2 && !/credential|secret|token/i.test(fks));

  const rlsEnabled = sql(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname='${TABLE}' and relrowsecurity`);
  check("30 RLS enabled", rlsEnabled === "1");

  const browserWritePolicies = sql(
    `select count(*) from pg_policies where schemaname='public' and tablename='${TABLE}' and cmd in ('INSERT','UPDATE','DELETE','ALL') and (roles @> array['anon']::name[] or roles @> array['authenticated']::name[])`
  );
  check("31 no browser write policies", browserWritePolicies === "0");

  const selectPolicies = sql(`select count(*) from pg_policies where schemaname='public' and tablename='${TABLE}' and cmd='SELECT'`);
  check("schema exactly one select policy", selectPolicies === "1");

  const secretColumns = sql(
    `select count(*) from information_schema.columns where table_schema='public' and table_name='${TABLE}' and column_name ~* '(secret|token|credential|password|apikey|authorization|capability)'`
  );
  check("32 no secret/credential-like columns", secretColumns === "0");

  console.log("SOR8C_SCHEMA_INTROSPECTION=PASS");

}

function migration00013Unchanged() {
  const path = join(__dirname, "../supabase/migrations/20270101000013_create_tact_governance_invocations_decisions.sql");
  const content = readFileSync(path, "utf8");
  check(
    "34 migration 00013 unchanged",
    ["tact_governance_invocations", "tact_governance_decisions", "tact_governance_invocation_execution_links", "runs_permission_snapshot"].every((needle) =>
      content.includes(needle)
    )
  );
}

function noPublicRouteIntroduced() {
  const apiRoot = join(__dirname, "../app/api/tact");
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else paths.push(full);
    }
  };
  walk(apiRoot);
  check("35 no public SOR-8C route introduced", !paths.some((p) => p.toLowerCase().includes("downstream")));
}

async function main() {

  const a = await createUser("a");
  const b = await createUser("b");

  try {

    const x1 = await createExecution(a.id);
    const x2 = await createExecution(a.id);
    const x3 = await createExecution(a.id);
    const x4 = await createExecution(a.id);
    const x5 = await createExecution(a.id);
    const x6 = await createExecution(a.id);
    const executionIds = [x1, x2, x3, x4, x5, x6];

    // 1-2: zero evidence execution => derived Downstream Permission Unknown
    const zeroEvidence = await listDownstreamPermissionEvidenceForExecution(x1, a.id);
    check("1 zero evidence execution", zeroEvidence.length === 0);
    const x1Row = await getExecutionById(x1, a.id);
    if (!x1Row) throw new Error("fixture execution x1 could not be read back");
    const zeroCompare = compareDownstreamPermissionEvidence({ execution: x1Row, registeredPermissionResult: decision("allowed"), downstreamEvidence: zeroEvidence });
    check("2 zero rows => derived downstreamPermissionUnknown", zeroCompare.downstreamPermissionUnknown === true);

    // 3: authoritative ALLOW persists
    const allowInput = evidenceInput(x1, a.id, { permissionState: "allowed" });
    const allowOutcome = await recordDownstreamPermissionEvidence(allowInput);
    check("3 authoritative ALLOW persists", allowOutcome.status === "created");
    check("18 service-role insert succeeds", allowOutcome.status === "created");

    // 4: authoritative DENY persists (separate execution)
    const denyOutcome = await recordDownstreamPermissionEvidence(evidenceInput(x2, a.id, { permissionState: "denied" }));
    check("4 authoritative DENY persists", denyOutcome.status === "created");

    // 5: explicit UNKNOWN persists honestly
    const unknownOutcome = await recordDownstreamPermissionEvidence(evidenceInput(x3, a.id, { permissionState: "unknown" }));
    check("5 explicit UNKNOWN persists honestly", unknownOutcome.status === "created" && unknownOutcome.status === "created" && unknownOutcome.evidence.permissionState === "unknown");

    // 6: NON_AUTHORITATIVE evidence persists but never promotes a strong downstream claim
    const nonAuthOutcome = await recordDownstreamPermissionEvidence(evidenceInput(x4, a.id, { permissionState: "allowed", authorityLevel: "NON_AUTHORITATIVE" }));
    check("6 NON_AUTHORITATIVE evidence persists", nonAuthOutcome.status === "created");
    const x4Row = await getExecutionById(x4, a.id);
    if (!x4Row) throw new Error("fixture execution x4 could not be read back");
    const nonAuthEvidence = await listDownstreamPermissionEvidenceForExecution(x4, a.id);
    const nonAuthCompare = compareDownstreamPermissionEvidence({ execution: x4Row, registeredPermissionResult: null, downstreamEvidence: nonAuthEvidence });
    check("6 NON_AUTHORITATIVE never promotes strong downstream claim", nonAuthCompare.downstreamPermissionUnknown === true);

    // 7: UNKNOWN authority behaves conservatively
    const unknownAuthorityOutcome = await recordDownstreamPermissionEvidence(evidenceInput(x5, a.id, { permissionState: "denied", authorityLevel: "UNKNOWN" }));
    check("7 UNKNOWN authority evidence persists", unknownAuthorityOutcome.status === "created");
    const x5Row = await getExecutionById(x5, a.id);
    if (!x5Row) throw new Error("fixture execution x5 could not be read back");
    const unknownAuthorityEvidence = await listDownstreamPermissionEvidenceForExecution(x5, a.id);
    const unknownAuthorityCompare = compareDownstreamPermissionEvidence({ execution: x5Row, registeredPermissionResult: decision("allowed"), downstreamEvidence: unknownAuthorityEvidence });
    check("7 UNKNOWN authority behaves conservatively (no conflict)", unknownAuthorityCompare.downstreamPermissionConflict === false);

    // 8-10: multiple evidence rows per execution, old rows unchanged, distinct observations over time
    const firstOnX6 = await recordDownstreamPermissionEvidence(evidenceInput(x6, a.id, { permissionState: "allowed", observedAt: "2027-01-01T00:00:00.000Z" }));
    if (firstOnX6.status !== "created") throw new Error(`setup failed: ${firstOnX6.status}`);
    const firstSnapshot = JSON.stringify(firstOnX6.evidence);
    const secondOnX6 = await recordDownstreamPermissionEvidence(evidenceInput(x6, a.id, { permissionState: "denied", observedAt: "2027-02-01T00:00:00.000Z" }));
    if (secondOnX6.status !== "created") throw new Error(`setup failed: ${secondOnX6.status}`);
    check("8 multiple rows per execution", (await listDownstreamPermissionEvidenceForExecution(x6, a.id)).length === 2);
    const thirdOnX6 = await recordDownstreamPermissionEvidence(evidenceInput(x6, a.id, { permissionState: "unknown", observedAt: "2027-03-01T00:00:00.000Z" }));
    if (thirdOnX6.status !== "created") throw new Error(`setup failed: ${thirdOnX6.status}`);
    const rowsAfterThird = await listDownstreamPermissionEvidenceForExecution(x6, a.id);
    const refetchedFirst = rowsAfterThird.find((row) => row.id === firstOnX6.evidence.id);
    check("9 old row unchanged after later row", !!refetchedFirst && JSON.stringify(refetchedFirst) === firstSnapshot);
    check("10 same execution has distinct observations at distinct times", new Set(rowsAfterThird.map((row) => row.observedAt)).size === 3);

    // 11, 28: workId=null does not block evidence
    const x1WorkId = (await admin.from("tact_canonical_executions").select("work_id").eq("id", x1).single()).data?.work_id;
    check("11 workId=null does not block evidence", x1WorkId === null && allowOutcome.status === "created");
    const allWorkIdsNull = (await admin.from("tact_canonical_executions").select("work_id").in("id", executionIds)).data?.every((row) => row.work_id === null);
    check("28 no Work dependency across fixtures", allWorkIdsNull === true);

    // 12: cross-tenant FK insert rejected (execution belongs to a, user_id claims b)
    const crossTenant = await admin.from(TABLE).insert({
      id: randomUUID(),
      user_id: b.id,
      execution_id: x1,
      target_provider: "notion",
      subject_kind: "ai_agent",
      action_category: "update",
      operation: "notion_update_page",
      permission_state: "allowed",
      source_type: "provider_acl",
      authority_level: "AUTHORITATIVE",
      trust_level: "INTERNAL",
      observed_at: now,
    });
    check("12 cross-tenant FK insert rejected", !!crossTenant.error);

    // 13: tenant B cannot read tenant A's evidence
    const browserB = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    await browserB.auth.signInWithPassword({ email: b.email, password: b.password });
    const foreignRead = await browserB.from(TABLE).select("id").eq("execution_id", x1);
    check("13 tenant B cannot read tenant A's evidence", (foreignRead.data ?? []).length === 0);

    // 14-17: anon/authenticated write boundary
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const anonInsert = await anon.from(TABLE).insert({
      id: randomUUID(), user_id: a.id, execution_id: x1, target_provider: "notion", subject_kind: "ai_agent",
      action_category: "update", operation: "notion_update_page", permission_state: "allowed",
      source_type: "provider_acl", authority_level: "AUTHORITATIVE", trust_level: "INTERNAL", observed_at: now,
    });
    check("14 anon insert denied", !!anonInsert.error);

    const browserA = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    await browserA.auth.signInWithPassword({ email: a.email, password: a.password });
    const browserInsert = await browserA.from(TABLE).insert({
      id: randomUUID(), user_id: a.id, execution_id: x1, target_provider: "notion", subject_kind: "ai_agent",
      action_category: "update", operation: "notion_update_page", permission_state: "allowed",
      source_type: "provider_acl", authority_level: "AUTHORITATIVE", trust_level: "INTERNAL", observed_at: now,
    });
    check("15 authenticated insert denied", !!browserInsert.error);

    const browserUpdate = await browserA.from(TABLE).update({ permission_state: "denied" }).eq("id", allowInput.id).select("id");
    check("16 authenticated update denied", !browserUpdate.error ? (browserUpdate.data ?? []).length === 0 : true);

    const browserDelete = await browserA.from(TABLE).delete().eq("id", allowInput.id).select("id");
    check("17 authenticated delete denied", !browserDelete.error ? (browserDelete.data ?? []).length === 0 : true);

    // 19-20: idempotency — same id/same content vs same id/different content
    const retrySameContent = await recordDownstreamPermissionEvidence(allowInput);
    check("19 same id + same content => already_exists", retrySameContent.status === "already_exists");

    const retryDifferentContent = await recordDownstreamPermissionEvidence({ ...allowInput, permissionState: "denied" });
    check("20 same id + different content => idempotency_conflict", retryDifferentContent.status === "idempotency_conflict");

    // 21: timestamp formatting equivalence survives retry
    const tzInput = evidenceInput(x1, a.id, { id: randomUUID(), observedAt: "2027-01-01T00:00:00.000Z" });
    const tzFirst = await recordDownstreamPermissionEvidence(tzInput);
    if (tzFirst.status !== "created") throw new Error(`setup failed: ${tzFirst.status}`);
    const tzRetry = await recordDownstreamPermissionEvidence({ ...tzInput, observedAt: "2027-01-01T00:00:00.000+00:00" });
    check("21 timestamp formatting equivalence survives retry", tzRetry.status === "already_exists");

    // 22: canonical JSON key-order equivalence survives retry
    const snapshotInput = evidenceInput(x1, a.id, { id: randomUUID(), evidenceSnapshot: { a: 1, b: 2 } });
    const snapshotFirst = await recordDownstreamPermissionEvidence(snapshotInput);
    if (snapshotFirst.status !== "created") throw new Error(`setup failed: ${snapshotFirst.status}`);
    const snapshotRetry = await recordDownstreamPermissionEvidence({ ...snapshotInput, evidenceSnapshot: { b: 2, a: 1 } });
    check("22 canonical JSON key-order equivalence survives retry", snapshotRetry.status === "already_exists");

    // 23-24: validation guards
    const oversized = await recordDownstreamPermissionEvidence(evidenceInput(x1, a.id, { id: randomUUID(), evidenceSnapshot: { blob: "x".repeat(5000) } }));
    check("23 oversized evidenceSnapshot rejected", oversized.status === "invalid");

    const secretKey = await recordDownstreamPermissionEvidence(evidenceInput(x1, a.id, { id: randomUUID(), evidenceSnapshot: { token: "nope" } }));
    check("24 secret/token-like snapshot key rejected", secretKey.status === "invalid");

    // 25-27: existing layers and Attention are untouched by any of the above
    const permissionDecisionCount = await admin.from("tact_execution_permission_decisions").select("id", { count: "exact", head: true }).in("execution_id", executionIds);
    check("25 tact_execution_permission_decisions unchanged", (permissionDecisionCount.count ?? 0) === 0);

    const governanceInvocationCount = await admin.from("tact_governance_invocations").select("id", { count: "exact", head: true }).eq("user_id", a.id);
    const governanceLinkCount = await admin.from("tact_governance_invocation_execution_links").select("id", { count: "exact", head: true }).in("execution_id", executionIds);
    check("26 tact_governance_* unchanged", (governanceInvocationCount.count ?? 0) === 0 && (governanceLinkCount.count ?? 0) === 0);

    const attentionCount = await admin.from("tact_execution_attentions").select("id", { count: "exact", head: true }).in("execution_id", executionIds);
    check("27 no tact_execution_attentions created", (attentionCount.count ?? 0) === 0);

    schemaIntrospection();
    migration00013Unchanged();
    noPublicRouteIntroduced();

    // Fail loudly, before printing any PASS marker, if the executed check
    // count ever drifts from EXPECTED_CHECKS in either direction (a removed
    // check as much as an uncounted extra one).
    assert.equal(checks.length, EXPECTED_CHECKS, `expected exactly ${EXPECTED_CHECKS} checks, executed ${checks.length}`);

    console.log(`SOR8C_DB_ACCEPTANCE=${checks.length}/${EXPECTED_CHECKS}`);
    console.log(
      "SOR8C_TENANT_ISOLATION=PASS\nSOR8C_IDEMPOTENCY=PASS\nSOR8C_APPEND_ONLY=PASS\nSOR8C_PERMISSION_SEPARATION=PASS\nSOR8C_NO_ATTENTION_SIDE_EFFECT=PASS"
    );

  } finally {
    await admin.auth.admin.deleteUser(a.id);
    await admin.auth.admin.deleteUser(b.id);
  }

}

main().catch((e) => {
  const error = e instanceof Error ? e : new Error(String(e));
  console.error("SOR8C_DB_ACCEPTANCE=FAIL", { name: error.name, message: error.message, stack: error.stack });
  process.exitCode = 1;
});
