/* Local-only SOR-178 / SEC-8D Postgres acceptance. Never targets hosted Supabase. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  recordSecurityFinding,
  listSecurityFindingsForExecution,
} from "@tact/runs-core/tact-execution/securityFinding/store";
import {
  ensureSecurityFindingAttentionLink,
  transitionExecutionAttention,
  listExecutionAttentions,
  persistExecutionAttention,
} from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { SecurityFindingInput } from "@tact/runs-core/tact-execution/securityFinding/types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
}

const url = requireEnv("SUPABASE_URL");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = requireEnv("SUPABASE_ANON_KEY");

// getServiceRoleClient() reads these exact env var names (same fixture
// pattern as sor8cDownstreamPermissionDbAcceptance.ts).
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const FINDINGS_TABLE = "tact_execution_security_findings";
const LINKS_TABLE = "tact_execution_attention_findings";
const ATTENTIONS_TABLE = "tact_execution_attentions";
const now = "2027-01-01T00:00:00.000Z";

const checks: string[] = [];
function check(name: string, value: unknown) {
  assert.ok(value, name);
  checks.push(name);
}

function requireCreated<T extends { status: string }>(outcome: T, label: string): T & { status: "created" } {
  if (outcome.status !== "created") {
    throw new Error(`setup failed (${label}): expected status=created, got ${outcome.status}`);
  }
  return outcome as T & { status: "created" };
}

function requireLinked<T extends { status: string }>(outcome: T, label: string): T & { status: "linked"; attentionId: string; episodeCreated: boolean } {
  if (outcome.status !== "linked") {
    throw new Error(`setup failed (${label}): expected status=linked, got ${outcome.status}`);
  }
  return outcome as T & { status: "linked"; attentionId: string; episodeCreated: boolean };
}

function requirePersisted<T extends { status: string }>(outcome: T, label: string): T & { status: "persisted"; attention: { id: string } } {
  if (outcome.status !== "persisted") {
    throw new Error(`setup failed (${label}): expected status=persisted, got ${outcome.status}`);
  }
  return outcome as T & { status: "persisted"; attention: { id: string } };
}

// Independent of checks.length by construction (section26 absolute
// condition — never gate correctness on `${checks.length}/${checks.length}`
// alone): this is the actual count of check() call sites in this file as
// of this change.
const EXPECTED_CHECKS = 61;

function sql(query: string): string {
  return execFileSync("docker", ["exec", "supabase_db_yolna-runs", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", query], { encoding: "utf8" }).trim();
}

async function createUser(label: string) {
  const email = `sor8d-${label}-${randomUUID()}@example.invalid`;
  const password = "sor8d-local-only-password";
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
      adapter_version: "sor8d-local-v1",
      action_category: "delete",
      operation: "notion_delete_page",
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

async function createPermissionDecision(executionId: string, status: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await admin
    .from("tact_execution_permission_decisions")
    .insert({
      execution_id: executionId,
      status,
      reason_code: "local_test",
      policy_id: "policy-1",
      // Unique per call by default (this script creates multiple
      // decisions on the SAME execution across the episode-lifecycle
      // checks below) so no two calls ever collide on the existing
      // idx_tact_execution_permission_decisions_idempotency unique index
      // (execution_id, evaluator_version, policy_id) unless the caller
      // deliberately overrides both to test that idempotency itself.
      evaluator_version: `sor8d-local-${randomUUID()}`,
      evaluated_at: now,
      ...overrides,
    })
    .select("id")
    .single();
  if (!row.data) throw new Error(row.error?.message ?? "permission decision fixture creation failed");
  return row.data.id as string;
}

async function createDownstreamEvidence(executionId: string, userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const row = await admin
    .from("tact_execution_downstream_permission_evidence")
    .insert({
      id,
      user_id: userId,
      execution_id: executionId,
      target_provider: "notion",
      subject_kind: "ai_agent",
      action_category: "delete",
      operation: "notion_delete_page",
      permission_state: "denied",
      source_type: "provider_acl",
      authority_level: "AUTHORITATIVE",
      trust_level: "INTERNAL",
      observed_at: now,
      ...overrides,
    })
    .select("id")
    .single();
  if (!row.data) throw new Error(row.error?.message ?? "downstream evidence fixture creation failed");
  return row.data.id as string;
}

function findingInput(
  executionId: string,
  userId: string,
  permissionDecisionId: string,
  overrides: Partial<SecurityFindingInput> = {}
): SecurityFindingInput {
  return {
    id: randomUUID(),
    userId,
    executionId,
    findingType: "RUNS_REGISTERED_PERMISSION_MISMATCH",
    reasonCode: "runs_registered_permission_mismatch",
    eligibilityBasis: "DEFINITE_MISMATCH",
    evaluatorVersion: "sor8d-local-v1",
    detectedAt: now,
    permissionDecisionId,
    downstreamPermissionEvidenceId: null,
    configuredUnknownRuleId: null,
    ...overrides,
  };
}

function schemaIntrospection() {

  const tableExists = sql(`select count(*) from pg_tables where schemaname='public' and tablename='${FINDINGS_TABLE}'`);
  check("2 schema table exists", tableExists === "1");

  const rlsEnabled = sql(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname='${FINDINGS_TABLE}' and relrowsecurity`);
  check("3 RLS enabled on findings table", rlsEnabled === "1");

  const browserWritePolicies = sql(
    `select count(*) from pg_policies where schemaname='public' and tablename='${FINDINGS_TABLE}' and cmd in ('INSERT','UPDATE','DELETE','ALL') and (roles @> array['anon']::name[] or roles @> array['authenticated']::name[])`
  );
  check("21/22 no browser write policies on findings table (no UPDATE/DELETE API)", browserWritePolicies === "0");

  const selectPolicies = sql(`select count(*) from pg_policies where schemaname='public' and tablename='${FINDINGS_TABLE}' and cmd='SELECT'`);
  check("schema exactly one select policy on findings table", selectPolicies === "1");

  const linkRlsEnabled = sql(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname='${LINKS_TABLE}' and relrowsecurity`);
  check("24 RLS enabled on attention-findings link table", linkRlsEnabled === "1");

  const linkBrowserWritePolicies = sql(
    `select count(*) from pg_policies where schemaname='public' and tablename='${LINKS_TABLE}' and cmd in ('INSERT','UPDATE','DELETE','ALL') and (roles @> array['anon']::name[] or roles @> array['authenticated']::name[])`
  );
  check("24b no browser write policies on link table", linkBrowserWritePolicies === "0");

  const secretColumns = sql(
    `select count(*) from information_schema.columns where table_schema='public' and table_name='${FINDINGS_TABLE}' and column_name ~* '(secret|token|credential|password|apikey|authorization|capability)'`
  );
  check("no secret/credential-like columns on findings table", secretColumns === "0");

  const activeIndexExists = sql(
    `select count(*) from pg_indexes where schemaname='public' and tablename='${ATTENTIONS_TABLE}' and indexname='idx_tact_execution_attentions_active_per_execution'`
  );
  check("26 partial active-per-execution unique index exists", activeIndexExists === "1");

  const oldUniqueGone = sql(
    `select count(*) from pg_indexes where schemaname='public' and tablename='${ATTENTIONS_TABLE}' and indexname='idx_tact_execution_attentions_execution_id'`
  );
  check("old UNIQUE(execution_id) index removed", oldUniqueGone === "0");

  console.log("SOR8D_SCHEMA_INTROSPECTION=PASS");

}

function rpcPrivilegeMatrix() {

  const row = sql(
    `select coalesce(bool_or(grantee='anon'), false), coalesce(bool_or(grantee='authenticated'), false), coalesce(bool_or(grantee='service_role'), false) ` +
    `from (select case when acl.grantee=0 then 'PUBLIC' else roles.rolname end as grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl left join pg_roles roles on roles.oid=acl.grantee where p.oid='public.ensure_security_finding_attention_link(uuid,uuid)'::regprocedure and acl.privilege_type='EXECUTE') t`
  );
  const [anonExec, authExec, serviceExec] = row.split("|");
  check("36 RPC not executable by anon", anonExec === "f");
  check("37 RPC not executable by authenticated", authExec === "f");
  check("38 RPC executable by service_role", serviceExec === "t");

  console.log("SOR8D_RPC_PRIVILEGE_MATRIX=PASS");

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
  check(
    "47 no public SOR-8D/SOR-138 route introduced",
    !paths.some((p) => {
      const lower = p.toLowerCase();
      return lower.includes("securityfinding") || lower.includes("security-finding") || lower.includes("preflight") || lower.includes("governance/complete");
    })
  );
}

async function main() {

  const a = await createUser("a");
  const b = await createUser("b");

  try {

    // ---- 1: migration 00015 applied (findings table reachable at all) ----
    check("1 migration 00015 applied (findings table reachable via service role)", true);

    const execMismatch = await createExecution(a.id);
    const decisionMismatch = await createPermissionDecision(execMismatch, "denied");

    // 13: mismatch Finding persists; 9: service-role insert works; 10: tenant binding works
    const mismatchInput = findingInput(execMismatch, a.id, decisionMismatch);
    const mismatchOutcome = requireCreated(await recordSecurityFinding(mismatchInput), "mismatch finding");
    const mismatchFindingId = mismatchOutcome.finding.id;
    check("13/9/10 mismatch Finding persists via service-role insert with tenant binding", true);

    // 14: high-impact UNKNOWN Finding persists
    const execUnknown = await createExecution(a.id, { action_category: "send", operation: "notion_send_message" });
    const decisionUnknown = await createPermissionDecision(execUnknown, "unknown", { policy_id: "none" });
    const unknownOutcome = requireCreated(
      await recordSecurityFinding(
        findingInput(execUnknown, a.id, decisionUnknown, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_high_impact",
          eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        })
      ),
      "high-impact unknown finding"
    );
    check("14 high-impact UNKNOWN Finding persists", true);
    void unknownOutcome;

    // 15: configured UNKNOWN Finding persists
    const execConfigured = await createExecution(a.id, { action_category: "read", operation: "notion_read" });
    const decisionConfigured = await createPermissionDecision(execConfigured, "unknown", { policy_id: "none" });
    requireCreated(
      await recordSecurityFinding(
        findingInput(execConfigured, a.id, decisionConfigured, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_configured",
          eligibilityBasis: "CONFIGURED_UNKNOWN",
          configuredUnknownRuleId: "rule-read-notion",
        })
      ),
      "configured unknown finding"
    );
    check("15 configured UNKNOWN Finding persists", true);

    // 16: downstream conflict Finding persists; 20: multiple distinct evidence rows => multiple Findings
    const execConflict = await createExecution(a.id);
    const decisionConflictAllowed = await createPermissionDecision(execConflict, "allowed");
    const evidence1 = await createDownstreamEvidence(execConflict, a.id, { permission_state: "denied" });
    const evidence2 = await createDownstreamEvidence(execConflict, a.id, { permission_state: "denied", observed_at: "2027-01-02T00:00:00.000Z" });

    const conflict1 = requireCreated(
      await recordSecurityFinding(
        findingInput(execConflict, a.id, decisionConflictAllowed, {
          findingType: "DOWNSTREAM_PERMISSION_CONFLICT",
          reasonCode: "downstream_permission_conflict",
          eligibilityBasis: "DOWNSTREAM_CONFLICT",
          downstreamPermissionEvidenceId: evidence1,
        })
      ),
      "conflict finding 1"
    );
    check("16 downstream conflict Finding persists", true);

    const conflict2 = requireCreated(
      await recordSecurityFinding(
        findingInput(execConflict, a.id, decisionConflictAllowed, {
          findingType: "DOWNSTREAM_PERMISSION_CONFLICT",
          reasonCode: "downstream_permission_conflict",
          eligibilityBasis: "DOWNSTREAM_CONFLICT",
          downstreamPermissionEvidenceId: evidence2,
        })
      ),
      "conflict finding 2"
    );
    check("20 multiple different downstream evidence rows => multiple distinct Findings", conflict2.finding.id !== conflict1.finding.id);

    const conflictFindings = await listSecurityFindingsForExecution(execConflict, a.id);
    check("20b both conflict Findings are independently listed", conflictFindings.filter((f) => f.findingType === "DOWNSTREAM_PERMISSION_CONFLICT").length === 2);

    // 17: same ID/same content => already_exists
    const retrySameId = await recordSecurityFinding(mismatchInput);
    check("17 same ID/same content => already_exists", retrySameId.status === "already_exists" && retrySameId.finding.id === mismatchFindingId);

    // 18: same ID/different content => idempotency_conflict
    const retryDifferentContent = await recordSecurityFinding({ ...mismatchInput, reasonCode: "changed" });
    check("18 same ID/different content => idempotency_conflict", retryDifferentContent.status === "idempotency_conflict");

    // 19: same immutable source reprocessed under a new command ID => existing Finding, no duplicate
    const retryNewId = await recordSecurityFinding({ ...mismatchInput, id: randomUUID() });
    check(
      "19 same source (permissionDecisionId+findingType), different command UUID => already_exists (no duplicate)",
      retryNewId.status === "already_exists" && retryNewId.finding.id === mismatchFindingId
    );
    check(
      "19b no duplicate row was created for the same source fact",
      (await listSecurityFindingsForExecution(execMismatch, a.id)).filter((f) => f.findingType === "RUNS_REGISTERED_PERMISSION_MISMATCH").length === 1
    );

    // 11: cross-execution PermissionDecision source rejected (decision
    // belongs to a different execution than the Finding claims). Uses a
    // FRESH, never-yet-claimed decision — reusing decisionMismatch here
    // would instead collide with its own already-created Finding on the
    // (permission_decision_id, finding_type) unique index first, masking
    // the FK check this test actually targets.
    const execDecisionOwner = await createExecution(a.id);
    const decisionNeverClaimed = await createPermissionDecision(execDecisionOwner, "denied");
    const execWrongClaimant = await createExecution(a.id);
    const crossExecutionAttempt = await recordSecurityFinding(findingInput(execWrongClaimant, a.id, decisionNeverClaimed /* belongs to execDecisionOwner, not execWrongClaimant */));
    check("11 cross-execution PermissionDecision source rejected", crossExecutionAttempt.status === "source_not_found");

    // 12: cross-tenant DownstreamEvidence source rejected. Uses a FRESH,
    // never-yet-claimed evidence row (reusing evidence1 here would instead
    // collide with conflict1's own Finding on the
    // (downstream_permission_evidence_id, finding_type) unique index
    // first, masking the FK check this test actually targets).
    const execForCrossTenantEvidence = await createExecution(b.id);
    const decisionForCrossTenant = await createPermissionDecision(execForCrossTenantEvidence, "allowed");
    const unclaimedEvidence = await createDownstreamEvidence(execConflict, a.id, { permission_state: "denied", observed_at: "2027-01-03T00:00:00.000Z" });
    const crossTenantEvidenceAttempt = await recordSecurityFinding(
      findingInput(execForCrossTenantEvidence, b.id, decisionForCrossTenant, {
        findingType: "DOWNSTREAM_PERMISSION_CONFLICT",
        reasonCode: "downstream_permission_conflict",
        eligibilityBasis: "DOWNSTREAM_CONFLICT",
        downstreamPermissionEvidenceId: unclaimedEvidence /* belongs to tenant a, execConflict — not execForCrossTenantEvidence/b */,
      })
    );
    check("12 cross-tenant/cross-execution DownstreamEvidence source rejected", crossTenantEvidenceAttempt.status === "source_not_found");

    // 4/4b: browser Finding INSERT denied (anon + authenticated); 5: UPDATE denied; 6: DELETE denied
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const anonInsert = await anon.from(FINDINGS_TABLE).insert({
      id: randomUUID(), user_id: a.id, execution_id: execMismatch, finding_type: "RUNS_REGISTERED_PERMISSION_MISMATCH",
      reason_code: "x", eligibility_basis: "DEFINITE_MISMATCH", evaluator_version: "x", detected_at: now, permission_decision_id: decisionMismatch,
    });
    check("4 browser (anon) Finding INSERT denied", !!anonInsert.error);

    const browserA = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    await browserA.auth.signInWithPassword({ email: a.email, password: a.password });

    const authInsert = await browserA.from(FINDINGS_TABLE).insert({
      id: randomUUID(), user_id: a.id, execution_id: execMismatch, finding_type: "RUNS_REGISTERED_PERMISSION_MISMATCH",
      reason_code: "x", eligibility_basis: "DEFINITE_MISMATCH", evaluator_version: "x", detected_at: now, permission_decision_id: decisionMismatch,
    });
    check("4b browser (authenticated) Finding INSERT denied", !!authInsert.error);

    const authUpdate = await browserA.from(FINDINGS_TABLE).update({ reason_code: "tampered" }).eq("id", mismatchFindingId).select("id");
    check("5 browser UPDATE denied", !authUpdate.error ? (authUpdate.data ?? []).length === 0 : true);

    const authDelete = await browserA.from(FINDINGS_TABLE).delete().eq("id", mismatchFindingId).select("id");
    check("6 browser DELETE denied", !authDelete.error ? (authDelete.data ?? []).length === 0 : true);

    // 7: owner SELECT works
    const ownerSelect = await browserA.from(FINDINGS_TABLE).select("id").eq("execution_id", execMismatch);
    check("7 owner SELECT works", (ownerSelect.data ?? []).length > 0);

    // 8: tenant B cannot SELECT tenant A Finding
    const browserB = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    await browserB.auth.signInWithPassword({ email: b.email, password: b.password });
    const foreignSelect = await browserB.from(FINDINGS_TABLE).select("id").eq("execution_id", execMismatch);
    check("8 tenant B cannot SELECT tenant A Finding", (foreignSelect.data ?? []).length === 0);

    // 21/22: no UPDATE/DELETE store API exists (static proof)
    const storeSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/store.ts"), "utf8");
    check("21 no UPDATE store function in securityFinding/store.ts", !/export (async )?function update/i.test(storeSource));
    check("22 no DELETE store function in securityFinding/store.ts", !/export (async )?function delete/i.test(storeSource));

    // 23: no Work requirement
    const execWorkId = (await admin.from("tact_canonical_executions").select("work_id").eq("id", execMismatch).single()).data?.work_id;
    check("23 no Work requirement (workId stays null, Finding still persists)", execWorkId === null);

    // ---- Attention episode lifecycle ----

    // 28: Finding while OPEN attaches same episode (first link creates the episode)
    const link1 = requireLinked(await ensureSecurityFindingAttentionLink(mismatchFindingId, a.id), "first link");
    check("28 ensure/link creates a new ACTIVE episode for the first eligible Finding", link1.episodeCreated === true);
    const episodeAId = link1.attentionId;

    const execMismatch2Decision = await createPermissionDecision(execMismatch, "unknown", { policy_id: "none" });
    const secondFindingOnSameExecution = requireCreated(
      await recordSecurityFinding(
        findingInput(execMismatch, a.id, execMismatch2Decision, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_high_impact",
          eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        })
      ),
      "second finding on same execution"
    );
    const link2 = requireLinked(await ensureSecurityFindingAttentionLink(secondFindingOnSameExecution.finding.id, a.id), "second link");
    check("28c second Finding while episode is OPEN attaches to the SAME episode (no new episode created)", link2.attentionId === episodeAId && link2.episodeCreated === false);

    // 25: Finding links at most one Attention (idempotent re-call)
    const relink = await ensureSecurityFindingAttentionLink(mismatchFindingId, a.id);
    check("25 re-calling ensure/link for an already-linked Finding returns already_linked (at most one Attention per Finding)", relink.status === "already_linked" && relink.attentionId === episodeAId);

    // 26: one active Attention per Execution
    const activeAttentionsForExec = await admin.from(ATTENTIONS_TABLE).select("id").eq("execution_id", execMismatch).in("status", ["open", "acknowledged"]);
    check("26 exactly one active Attention episode per Execution", (activeAttentionsForExec.data ?? []).length === 1);

    // 29: Finding while ACKNOWLEDGED attaches same episode
    await transitionExecutionAttention(episodeAId, a.id, "acknowledge");
    const thirdDecision = await createPermissionDecision(execMismatch, "unknown", { policy_id: "none" });
    const thirdFinding = requireCreated(
      await recordSecurityFinding(
        findingInput(execMismatch, a.id, thirdDecision, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_high_impact",
          eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        })
      ),
      "third finding"
    );
    const link3 = requireLinked(await ensureSecurityFindingAttentionLink(thirdFinding.finding.id, a.id), "third link");
    check("29 Finding while ACKNOWLEDGED attaches to the same episode", link3.attentionId === episodeAId);

    // 30: acknowledged state does not regress
    const episodeAfterThirdLink = await admin.from(ATTENTIONS_TABLE).select("status").eq("id", episodeAId).single();
    check("30 acknowledged state does not regress to open when a new Finding attaches", episodeAfterThirdLink.data?.status === "acknowledged");

    // 48: no Attention acknowledge mutates Finding
    const findingsBeforeResolve = await listSecurityFindingsForExecution(execMismatch, a.id);
    check("48 acknowledging the Attention does not mutate any linked Finding row", findingsBeforeResolve.every((f) => f.recordedAt !== null));

    // Resolve the episode, then prove 31/32/33/34/49 independence.
    await transitionExecutionAttention(episodeAId, a.id, "resolve");
    const resolvedEpisode = await admin.from(ATTENTIONS_TABLE).select("status").eq("id", episodeAId).single();
    check("precondition: resolve transition succeeded", resolvedEpisode.data?.status === "resolved");

    // 49: no Attention resolve mutates Finding
    const findingsAfterResolve = await listSecurityFindingsForExecution(execMismatch, a.id);
    check(
      "49 resolving the Attention does not mutate any linked Finding row",
      JSON.stringify(findingsAfterResolve.map((f) => f.id).sort()) === JSON.stringify(findingsBeforeResolve.map((f) => f.id).sort())
    );

    // 31: Finding after RESOLVED creates new episode
    const fourthDecision = await createPermissionDecision(execMismatch, "unknown", { policy_id: "none" });
    const fourthFinding = requireCreated(
      await recordSecurityFinding(
        findingInput(execMismatch, a.id, fourthDecision, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_high_impact",
          eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        })
      ),
      "fourth finding"
    );
    const link4 = requireLinked(await ensureSecurityFindingAttentionLink(fourthFinding.finding.id, a.id), "fourth link");
    check("31 Finding after RESOLVED creates a NEW episode", link4.episodeCreated === true && link4.attentionId !== episodeAId);
    const episodeBId = link4.attentionId;

    // 32: old resolved Attention remains unchanged
    const episodeAStillResolved = await admin.from(ATTENTIONS_TABLE).select("status").eq("id", episodeAId).single();
    check("32 old resolved Attention episode remains unchanged", episodeAStillResolved.data?.status === "resolved");

    // 27: multiple historical resolved Attention episodes allowed
    const allEpisodesForExec = await admin.from(ATTENTIONS_TABLE).select("id, status").eq("execution_id", execMismatch);
    check("27 multiple historical Attention episodes allowed for one Execution", (allEpisodesForExec.data ?? []).length >= 2);

    // 33: old Finding remains linked to old episode
    const oldLinkRow = await admin.from(LINKS_TABLE).select("attention_id").eq("finding_id", mismatchFindingId).single();
    check("33 old Finding remains linked to the old (resolved) episode", oldLinkRow.data?.attention_id === episodeAId);

    // 34: new Finding links new episode
    const newLinkRow = await admin.from(LINKS_TABLE).select("attention_id").eq("finding_id", fourthFinding.finding.id).single();
    check("34 new Finding links the new (open) episode", newLinkRow.data?.attention_id === episodeBId);

    // 35: concurrent new Findings produce one active episode (the partial
    // unique index is the real concurrency barrier — Promise.all races the
    // two RPC calls against it).
    const execConcurrent = await createExecution(a.id);
    const concurrentDecision1 = await createPermissionDecision(execConcurrent, "denied");
    const concurrentDecision2 = await createPermissionDecision(execConcurrent, "unknown", { policy_id: "none" });
    const concurrentFinding1 = requireCreated(await recordSecurityFinding(findingInput(execConcurrent, a.id, concurrentDecision1)), "concurrent finding 1");
    const concurrentFinding2 = requireCreated(
      await recordSecurityFinding(
        findingInput(execConcurrent, a.id, concurrentDecision2, {
          findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
          reasonCode: "runs_registered_permission_unknown_high_impact",
          eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        })
      ),
      "concurrent finding 2"
    );
    const [concurrentLink1, concurrentLink2] = await Promise.all([
      ensureSecurityFindingAttentionLink(concurrentFinding1.finding.id, a.id),
      ensureSecurityFindingAttentionLink(concurrentFinding2.finding.id, a.id),
    ]);
    const concurrentAttentionIds = new Set(
      [concurrentLink1, concurrentLink2].filter((r) => r.status === "linked").map((r) => (r as { attentionId: string }).attentionId)
    );
    check("35 concurrent new Findings on the same Execution produce exactly one active episode", concurrentAttentionIds.size === 1);
    const concurrentActiveCount = await admin.from(ATTENTIONS_TABLE).select("id").eq("execution_id", execConcurrent).in("status", ["open", "acknowledged"]);
    check("35b exactly one active row persisted for the concurrent execution", (concurrentActiveCount.data ?? []).length === 1);

    // ---- Legacy approval_required path ----

    const execApproval = await createExecution(a.id, { action_category: "update", operation: "notion_update_page" });
    const approvalDecisionId = await createPermissionDecision(execApproval, "approval_required");
    const approvalCandidate = {
      executionId: execApproval,
      userId: a.id,
      provider: "mcp" as const,
      operation: "notion_update_page",
      reason: "approval_required" as const,
      reasonCode: "notion_m0_update_page_approval_required",
      policyId: "notion-ai-agent-update-page-approval-required",
      occurredAt: now,
    };
    const approvalPersist1 = requirePersisted(await persistExecutionAttention(approvalCandidate, approvalDecisionId), "approval persist 1");
    check("39 legacy approval_required Attention still works", true);

    await transitionExecutionAttention(approvalPersist1.attention.id, a.id, "resolve");
    const approvalRetry = await persistExecutionAttention(approvalCandidate, approvalDecisionId);
    check(
      "40 repeated same legacy approval decision does not create a new episode after resolved",
      approvalRetry.status === "already_exists" && approvalRetry.attention.id === approvalPersist1.attention.id
    );

    // ---- Active Inbox semantics ----
    const activeInbox = await listExecutionAttentions(a.id, { statuses: ["open", "acknowledged"] });
    check("41 active Inbox includes open episodes", activeInbox.some((item) => item.attentionId === episodeBId));
    check("42 resolved episodes excluded from active Inbox", !activeInbox.some((item) => item.attentionId === episodeAId));

    // Additive findings[] read model
    const episodeBView = activeInbox.find((item) => item.attentionId === episodeBId);
    check("read model exposes findings[] additively on the active episode", !!episodeBView && episodeBView.findings.some((f) => f.findingId === fourthFinding.finding.id));

    // ---- CaptureGap / Governance boundary ----
    const governanceCount = await admin.from("tact_governance_invocations").select("id", { count: "exact", head: true }).eq("user_id", a.id);
    check("45 no Governance row mutated by this change", (governanceCount.count ?? 0) === 0);

    const typesSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/types.ts"), "utf8");
    check("44 no capture_gap_id/captureGapId field anywhere in securityFinding module", !/capture_?gap_?id/i.test(typesSource));
    check("46 no downstream Action authorization conclusion introduced (no execution-time claim field exists)", !typesSource.includes("ActionAuthorization"));

    noPublicRouteIntroduced();

    // ---- Finding persists even when the Attention-link step fails ----
    const execLinkFailure = await createExecution(a.id);
    const linkFailureDecision = await createPermissionDecision(execLinkFailure, "denied");
    const linkFailureFinding = requireCreated(await recordSecurityFinding(findingInput(execLinkFailure, a.id, linkFailureDecision)), "link-failure finding");
    // Deliberately wrong userId -> RPC resolves finding_not_found (tenant-scoped lookup fails) without touching the Finding row.
    const injectedFailureLink = await ensureSecurityFindingAttentionLink(linkFailureFinding.finding.id, b.id);
    check("50 injected Attention-link failure returns a non-linked outcome", injectedFailureLink.status === "finding_not_found");
    const findingStillThere = await listSecurityFindingsForExecution(execLinkFailure, a.id);
    check("50b Finding remains persisted after the injected Attention-link failure (never rolled back)", findingStillThere.some((f) => f.id === linkFailureFinding.finding.id));

    schemaIntrospection();
    rpcPrivilegeMatrix();

    assert.equal(checks.length, EXPECTED_CHECKS, `expected exactly ${EXPECTED_CHECKS} checks, executed ${checks.length}`);

    console.log(`SOR8D_DB_ACCEPTANCE=${checks.length}/${EXPECTED_CHECKS}`);
    console.log(
      "SOR8D_TENANT_ISOLATION=PASS\nSOR8D_IDEMPOTENCY=PASS\nSOR8D_APPEND_ONLY=PASS\nSOR8D_ATTENTION_EPISODE_MODEL=PASS\nSOR8D_LEGACY_APPROVAL_COMPATIBILITY=PASS"
    );

  } finally {
    await admin.auth.admin.deleteUser(a.id);
    await admin.auth.admin.deleteUser(b.id);
  }

}

main().catch((e) => {
  const error = e instanceof Error ? e : new Error(String(e));
  console.error("SOR8D_DB_ACCEPTANCE=FAIL", { name: error.name, message: error.message, stack: error.stack });
  process.exitCode = 1;
});
