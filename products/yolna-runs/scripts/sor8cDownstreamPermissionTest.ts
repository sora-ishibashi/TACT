// Local, no-cloud SOR-8C focused pure/static proof: comparison semantics and migration shape.
// No DB access — see sor8cDownstreamPermissionDbAcceptance.ts for the real Postgres acceptance suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareDownstreamPermissionEvidence } from "@tact/runs-core/tact-execution/downstreamPermission/compare";
import { validateDownstreamPermissionEvidenceInput } from "@tact/runs-core/tact-execution/downstreamPermission/validation";
import type { DownstreamPermissionEvidence, DownstreamPermissionEvidenceInput } from "@tact/runs-core/tact-execution/downstreamPermission/types";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { PermissionDecision, PermissionDecisionStatus } from "@tact/runs-core/tact-execution/permission/types";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const baseExecution: CanonicalExecution = {
  id: "11111111-1111-1111-1111-111111111111",
  schemaVersion: 1,
  userId: "22222222-2222-2222-2222-222222222222",
  organizationId: null,
  workspaceId: null,
  workId: null,
  correlationStatus: "pending",
  connectionId: "conn-1",
  actorKind: "ai_agent",
  actorId: "agent-principal-1",
  agentId: "agent-1",
  onBehalfOfActorKind: null,
  onBehalfOfActorId: null,
  provider: "mcp",
  sourceType: "sdk_callback",
  externalEventId: "evt-1",
  adapterVersion: "sor8c-test-v1",
  sourceMetadata: null,
  rawPayloadRef: null,
  observationMode: "instrumented",
  preExecutionVisible: false,
  actionCategory: "update",
  operation: "notion_update_page",
  resourceType: "notion_page",
  resourceIdentifier: "page-1",
  targetProvider: "notion",
  status: "succeeded",
  errorCode: null,
  errorMessage: null,
  permissionStatus: "allowed",
  permissionReasonCode: null,
  permissionEvaluatedAt: null,
  outcomeStatus: "unknown",
  outcomeKind: null,
  providerOccurredAt: "2027-01-01T00:00:00.000Z",
  observedAt: "2027-01-01T00:00:05.000Z",
  persistedAt: "2027-01-01T00:00:06.000Z",
  updatedAt: "2027-01-01T00:00:06.000Z",
};

const decision = (status: PermissionDecisionStatus): PermissionDecision => ({
  executionId: baseExecution.id,
  status,
  reasonCode: "test",
  policyId: "policy-1",
  evaluatorVersion: "test-v1",
  evaluatedAt: "2027-01-01T00:00:07.000Z",
});

const evidence = (overrides: Partial<DownstreamPermissionEvidence> = {}): DownstreamPermissionEvidence => ({
  id: "33333333-3333-3333-3333-333333333333",
  userId: baseExecution.userId,
  executionId: baseExecution.id,
  targetProvider: "notion",
  connectionId: "conn-1",
  subjectKind: "ai_agent",
  subjectId: "agent-principal-1",
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
  observedAt: "2027-01-01T00:00:01.000Z",
  recordedAt: "2027-01-01T00:00:02.000Z",
  evidenceSnapshot: null,
  ...overrides,
});

// 1. zero evidence => Downstream Permission Unknown
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [] });
  check("1 zero evidence => unknown", result.downstreamPermissionUnknown === true);
  check("1 zero evidence => no conflict", result.downstreamPermissionConflict === false && result.conflictEvidenceIds.length === 0);
  check("1 zero evidence => no comparisons", result.evidenceComparisons.length === 0);
}

// 2-5. the fixed binary comparison matrix (section13)
{
  const allowedVsAllowed = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [evidence({ permissionState: "allowed" })] });
  check("2 authoritative allowed vs Runs allowed => consistent", allowedVsAllowed.evidenceComparisons[0].relationToRuns === "CONSISTENT");
  check("2 consistent => downstream not unknown", allowedVsAllowed.downstreamPermissionUnknown === false);
  check("2 consistent => no conflict", allowedVsAllowed.downstreamPermissionConflict === false);

  const deniedVsAllowed = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [evidence({ permissionState: "denied" })] });
  check("3 authoritative denied vs Runs allowed => conflict", deniedVsAllowed.evidenceComparisons[0].relationToRuns === "CONFLICT");
  check("3 conflict => downstreamPermissionConflict true", deniedVsAllowed.downstreamPermissionConflict === true && deniedVsAllowed.conflictEvidenceIds.includes(evidence().id));

  const allowedVsDenied = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed" })] });
  check("4 authoritative allowed vs Runs denied => conflict", allowedVsDenied.evidenceComparisons[0].relationToRuns === "CONFLICT");

  const deniedVsDenied = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "denied" })] });
  check("5 authoritative denied vs Runs denied => consistent", deniedVsDenied.evidenceComparisons[0].relationToRuns === "CONSISTENT");
}

// 6. Runs approval_required => NOT_COMPARABLE (never "unauthorized")
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("approval_required"), downstreamEvidence: [evidence({ permissionState: "allowed" })] });
  check("6 Runs approval_required => NOT_COMPARABLE", result.evidenceComparisons[0].relationToRuns === "NOT_COMPARABLE");
  check("6 approval_required conflict with allowed ACL never claimed", result.downstreamPermissionConflict === false);
}

// 7. Runs unknown => NOT_COMPARABLE (one of the two Human-Owner-permitted outcomes; see compare.ts comment)
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("unknown"), downstreamEvidence: [evidence({ permissionState: "denied" })] });
  check("7 Runs unknown => NOT_COMPARABLE", result.evidenceComparisons[0].relationToRuns === "NOT_COMPARABLE");
  check("7 Runs unknown => no conflict claimed", result.downstreamPermissionConflict === false);
}

// no registeredPermissionResult supplied at all (caller chose not to compare)
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: null, downstreamEvidence: [evidence({ permissionState: "denied" })] });
  check("7b null registeredPermissionResult => NOT_COMPARABLE", result.evidenceComparisons[0].relationToRuns === "NOT_COMPARABLE");
}

// 8. NON_AUTHORITATIVE allowed/denied never drives conflict
{
  const allowedNonAuth = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed", authorityLevel: "NON_AUTHORITATIVE" })] });
  check("8 NON_AUTHORITATIVE allowed vs Runs denied => UNKNOWN not CONFLICT", allowedNonAuth.evidenceComparisons[0].relationToRuns === "UNKNOWN");
  check("8 NON_AUTHORITATIVE never conflicts", allowedNonAuth.downstreamPermissionConflict === false);

  const deniedNonAuth = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [evidence({ permissionState: "denied", authorityLevel: "NON_AUTHORITATIVE" })] });
  check("8b NON_AUTHORITATIVE denied vs Runs allowed => UNKNOWN not CONFLICT", deniedNonAuth.evidenceComparisons[0].relationToRuns === "UNKNOWN");
  check("8b NON_AUTHORITATIVE never promotes to definite evidence", deniedNonAuth.downstreamPermissionUnknown === true);
}

// 9. UNKNOWN authority never drives conflict
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [evidence({ permissionState: "denied", authorityLevel: "UNKNOWN" })] });
  check("9 UNKNOWN authority => UNKNOWN not CONFLICT", result.evidenceComparisons[0].relationToRuns === "UNKNOWN");
  check("9 UNKNOWN authority never conflicts", result.downstreamPermissionConflict === false);
}

// 10. evidence permissionState=unknown => downstream unknown (even if AUTHORITATIVE)
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [evidence({ permissionState: "unknown", authorityLevel: "AUTHORITATIVE" })] });
  check("10 authoritative but unknown permissionState => relation UNKNOWN", result.evidenceComparisons[0].relationToRuns === "UNKNOWN");
  check("10 authoritative but unknown permissionState => downstream unknown", result.downstreamPermissionUnknown === true);
}

// 11-14. wrong identity dimensions => NOT_APPLICABLE, never guessed into CONSISTENT/CONFLICT
{
  const wrongSubject = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed", subjectId: "someone-else" })] });
  check("11 wrong subject => NOT_APPLICABLE", wrongSubject.evidenceComparisons[0].relationToRuns === "NOT_APPLICABLE");
  check("11 wrong subject reasonCode", wrongSubject.evidenceComparisons[0].applicability.reasonCode === "subject_id_mismatch");

  const wrongAgent = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed", agentId: "agent-2" })] });
  check("12 wrong agent => NOT_APPLICABLE", wrongAgent.evidenceComparisons[0].relationToRuns === "NOT_APPLICABLE");
  check("12 wrong agent reasonCode", wrongAgent.evidenceComparisons[0].applicability.reasonCode === "agent_mismatch");

  const wrongResource = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed", resourceIdentifier: "page-2" })] });
  check("13 wrong resource => NOT_APPLICABLE", wrongResource.evidenceComparisons[0].relationToRuns === "NOT_APPLICABLE");
  check("13 wrong resource reasonCode", wrongResource.evidenceComparisons[0].applicability.reasonCode === "resource_identifier_mismatch");

  const wrongAction = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed", actionCategory: "delete" })] });
  check("14 wrong action => NOT_APPLICABLE", wrongAction.evidenceComparisons[0].relationToRuns === "NOT_APPLICABLE");
  check("14 wrong action reasonCode", wrongAction.evidenceComparisons[0].applicability.reasonCode === "action_category_mismatch");

  // execution.targetProvider === null must never be substituted with execution.provider (section12 absolute condition).
  const nullTargetProviderExecution: CanonicalExecution = { ...baseExecution, targetProvider: null, provider: "notion" };
  const unknownTarget = compareDownstreamPermissionEvidence({ execution: nullTargetProviderExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed" })] });
  check("14b null execution.targetProvider never substituted => NOT_APPLICABLE", unknownTarget.evidenceComparisons[0].relationToRuns === "NOT_APPLICABLE");
  check("14b reasonCode names the unknown dimension", unknownTarget.evidenceComparisons[0].applicability.reasonCode === "execution_target_provider_unknown");
}

// 15-16. multiple rows remain separately represented; no latest-wins collapsing
{
  const older = evidence({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", permissionState: "denied", observedAt: "2027-01-01T00:00:01.000Z", recordedAt: "2027-01-01T00:00:01.500Z" });
  const newer = evidence({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", permissionState: "allowed", observedAt: "2027-01-02T00:00:00.000Z", recordedAt: "2027-01-02T00:00:00.500Z" });
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [older, newer] });
  check("15 multiple rows => two separate comparisons", result.evidenceComparisons.length === 2);
  check("16 older row still present and not overwritten by newer", result.evidenceComparisons.some((c) => c.evidenceId === older.id && c.relationToRuns === "CONFLICT"));
  check("16 newer row also present, consistent", result.evidenceComparisons.some((c) => c.evidenceId === newer.id && c.relationToRuns === "CONSISTENT"));
  check("16 conflict list contains only the conflicting row, not both", result.conflictEvidenceIds.length === 1 && result.conflictEvidenceIds[0] === older.id);
}

// 17. temporal relation is descriptive only — never changes relationToRuns
{
  const before = evidence({ observedAt: "2026-12-31T00:00:00.000Z" }); // before baseExecution.providerOccurredAt
  const after = evidence({ observedAt: "2027-06-01T00:00:00.000Z" }); // after baseExecution.providerOccurredAt
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("allowed"), downstreamEvidence: [before, after] });
  check("17 before reference temporal tag", result.evidenceComparisons[0].temporalRelation === "BEFORE_EXECUTION_REFERENCE");
  check("17 after reference temporal tag", result.evidenceComparisons[1].temporalRelation === "AFTER_EXECUTION_REFERENCE");
  check("17 temporal relation does not change relationToRuns", result.evidenceComparisons[0].relationToRuns === result.evidenceComparisons[1].relationToRuns && result.evidenceComparisons[0].relationToRuns === "CONSISTENT");
}

// 18. no downstreamActionPermissionConflict field exists anywhere on the result shape (SOR-164 boundary, section14)
{
  const result = compareDownstreamPermissionEvidence({ execution: baseExecution, registeredPermissionResult: decision("denied"), downstreamEvidence: [evidence({ permissionState: "allowed" })] });
  check("18 no downstreamActionPermissionConflict key on result", !("downstreamActionPermissionConflict" in result));
  check("18 no downstreamActionPermissionConflict key on per-evidence comparison", !("downstreamActionPermissionConflict" in result.evidenceComparisons[0]));
}

// =========================
// Validation: evidenceSnapshot size must be measured in UTF-8 bytes, not
// UTF-16 code units, to agree with migration 00014's
// octet_length(evidence_snapshot::text) <= 4096 DB constraint.
// =========================

function validationInput(overrides: Partial<DownstreamPermissionEvidenceInput> = {}): DownstreamPermissionEvidenceInput {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    userId: baseExecution.userId,
    executionId: baseExecution.id,
    targetProvider: "notion",
    connectionId: "conn-1",
    subjectKind: "ai_agent",
    subjectId: "agent-principal-1",
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
    observedAt: "2027-01-01T00:00:01.000Z",
    evidenceSnapshot: null,
    ...overrides,
  };
}

// 19. ASCII evidenceSnapshot below 4000 UTF-8 bytes passes.
{
  const asciiBlob = "x".repeat(3980); // JSON.stringify({ blob: ... }).length/byteLength both land at 3991 — same for pure ASCII, comfortably under 4000.
  const serialized = JSON.stringify({ blob: asciiBlob });
  check("19 ascii fixture is actually below the 4000-byte limit", Buffer.byteLength(serialized, "utf8") <= 4000);
  const result = validateDownstreamPermissionEvidenceInput(validationInput({ evidenceSnapshot: { blob: asciiBlob } }));
  check("19 ASCII evidenceSnapshot below 4000 UTF-8 bytes passes", result.ok === true);
}

// 20. ASCII evidenceSnapshot above 4000 UTF-8 bytes fails.
{
  const asciiBlob = "x".repeat(5000);
  const serialized = JSON.stringify({ blob: asciiBlob });
  check("20 ascii fixture is actually above the 4000-byte limit", Buffer.byteLength(serialized, "utf8") > 4000);
  const result = validateDownstreamPermissionEvidenceInput(validationInput({ evidenceSnapshot: { blob: asciiBlob } }));
  check("20 ASCII evidenceSnapshot above 4000 UTF-8 bytes fails", result.ok === false && result.errors.some((e) => e.includes("UTF-8 bytes")));
}

// 21. The actual byte/code-unit distinction: a multibyte Japanese/CJK
// evidenceSnapshot whose JSON.stringify(...).length (UTF-16 code units) is
// <= 4000 BUT whose UTF-8 byte length is > 4000 must still be rejected.
// Each "あ" (U+3042, BMP) is exactly 1 UTF-16 code unit but 3 UTF-8 bytes —
// 1500 of them plus the `{"blob":"...""}` wrapper (11 ASCII chars/bytes)
// gives length 1511 (well under 4000) and byte length 4511 (well over
// 4000). A validator that measured .length instead of byte length would
// wrongly accept this payload, which the DB's octet_length(...) <= 4096
// constraint would then reject — exactly the pre-fix mismatch.
{
  const cjkBlob = "あ".repeat(1500);
  const serialized = JSON.stringify({ blob: cjkBlob });

  check("21 CJK fixture code-unit length is <= 4000 (would have falsely passed the old check)", serialized.length <= 4000);
  check("21 CJK fixture UTF-8 byte length is > 4000 (must fail the new check)", Buffer.byteLength(serialized, "utf8") > 4000);
  check("21 CJK fixture demonstrates a real length/byte gap", Buffer.byteLength(serialized, "utf8") > serialized.length);

  const result = validateDownstreamPermissionEvidenceInput(validationInput({ evidenceSnapshot: { blob: cjkBlob } }));
  check("21 multibyte CJK evidenceSnapshot rejected by application validation despite code-unit length <= 4000", result.ok === false && result.errors.some((e) => e.includes("UTF-8 bytes")));
}

// Static migration structure checks (no DB — mirrors sor8bGovernanceTest.ts's own migration assertions)
{
  const migrationPath = join(__dirname, "../supabase/migrations/20270101000014_create_tact_execution_downstream_permission_evidence.sql");
  const migration = readFileSync(migrationPath, "utf8");

  for (const required of [
    "tact_execution_downstream_permission_evidence",
    "foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id)",
    "authority_level text not null",
    "trust_level text not null",
    "permission_state text not null",
    "'AUTHORITATIVE','NON_AUTHORITATIVE','UNKNOWN'",
    "'UNTRUSTED','AUTHENTICATED','INTERNAL'",
    "'allowed','denied','unknown'",
    "enable row level security",
    "tact_execution_downstream_permission_evidence_select_own",
    "recorded_at timestamptz not null default now()",
  ]) {
    check(`migration contains: ${required}`, migration.includes(required));
  }

  // No browser write policy of any kind — only the one select-own policy.
  check("migration defines exactly one policy", migration.split("create policy").length - 1 === 1);
  check("migration defines no update/delete function surface markers", !/for\s+(insert|update|delete|all)/i.test(migration));

  // Migration 00013 (governance) must remain untouched by this change.
  const governanceMigrationPath = join(__dirname, "../supabase/migrations/20270101000013_create_tact_governance_invocations_decisions.sql");
  const governanceMigration = readFileSync(governanceMigrationPath, "utf8");
  for (const required of ["tact_governance_invocations", "tact_governance_decisions", "tact_governance_invocation_execution_links"]) {
    check(`migration 00013 still contains: ${required}`, governanceMigration.includes(required));
  }
}

console.log(`SOR8C_FOCUSED_TESTS=${checks.length}/${checks.length}`);
