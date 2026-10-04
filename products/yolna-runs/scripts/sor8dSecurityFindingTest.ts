// Local, no-cloud SOR-178 / SEC-8D focused pure/static proof: derivation
// semantics and migration shape. No DB access — see
// sor8dSecurityFindingDbAcceptance.ts for the real Postgres acceptance
// suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveRunsPermissionSecurityFindingCandidate,
  deriveDownstreamPermissionSecurityFindingCandidates,
} from "@tact/runs-core/tact-execution/securityFinding/derive";
import { validateSecurityFindingInput } from "@tact/runs-core/tact-execution/securityFinding/validation";
import {
  SECURITY_FINDING_REASON_CODES,
  type ConfiguredUnknownAlertRule,
} from "@tact/runs-core/tact-execution/securityFinding/types";
import { deriveExecutionAttentionCandidate } from "@tact/runs-core/tact-execution/permission/attention";
import { compareDownstreamPermissionEvidence } from "@tact/runs-core/tact-execution/downstreamPermission/compare";
import type { DownstreamPermissionEvidence } from "@tact/runs-core/tact-execution/downstreamPermission/types";
import type { CanonicalExecution, ExecutionActionCategory } from "@tact/runs-core/tact-execution/types";
import type { PermissionDecision, PermissionDecisionStatus } from "@tact/runs-core/tact-execution/permission/types";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const PERMISSION_DECISION_ID = "55555555-5555-5555-5555-555555555555";

function baseExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
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
    adapterVersion: "sor8d-test-v1",
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
    permissionStatus: "unknown",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: "2027-01-01T00:00:00.000Z",
    observedAt: "2027-01-01T00:00:05.000Z",
    persistedAt: "2027-01-01T00:00:06.000Z",
    updatedAt: "2027-01-01T00:00:06.000Z",
    ...overrides,
  };
}

function decision(status: PermissionDecisionStatus, overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    executionId: "11111111-1111-1111-1111-111111111111",
    status,
    reasonCode: "test",
    policyId: "policy-1",
    evaluatorVersion: "test-v1",
    evaluatedAt: "2027-01-01T00:00:07.000Z",
    ...overrides,
  };
}

function evidence(overrides: Partial<DownstreamPermissionEvidence> = {}): DownstreamPermissionEvidence {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    userId: "22222222-2222-2222-2222-222222222222",
    executionId: "11111111-1111-1111-1111-111111111111",
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
  };
}

// 1. denied => mismatch Finding
{
  const candidate = deriveRunsPermissionSecurityFindingCandidate(baseExecution(), decision("denied"), PERMISSION_DECISION_ID);
  check("1 denied => RUNS_REGISTERED_PERMISSION_MISMATCH", candidate?.findingType === "RUNS_REGISTERED_PERMISSION_MISMATCH");
  check("1 denied => eligibilityBasis DEFINITE_MISMATCH", candidate?.eligibilityBasis === "DEFINITE_MISMATCH");
  check("1 denied => reasonCode is the fixed mismatch vocabulary", candidate?.reasonCode === SECURITY_FINDING_REASON_CODES.RUNS_REGISTERED_PERMISSION_MISMATCH);
  check("1 denied => downstreamPermissionEvidenceId null", candidate?.downstreamPermissionEvidenceId === null);
  check("1 denied => configuredUnknownRuleId null", candidate?.configuredUnknownRuleId === null);
  check("1 validates", validateSecurityFindingInput({ id: "x", ...candidate! }).ok === true);
}

// 2. approval_required => no SecurityFinding (DECISION B)
{
  const candidate = deriveRunsPermissionSecurityFindingCandidate(baseExecution(), decision("approval_required"), PERMISSION_DECISION_ID);
  check("2 approval_required => no SecurityFinding", candidate === null);
}

// 3. allowed => no SecurityFinding
{
  const candidate = deriveRunsPermissionSecurityFindingCandidate(baseExecution(), decision("allowed"), PERMISSION_DECISION_ID);
  check("3 allowed => no SecurityFinding", candidate === null);
}

// 4. low-impact unknown + no configured rule => no Finding
{
  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    baseExecution({ actionCategory: "read" }),
    decision("unknown"),
    PERMISSION_DECISION_ID,
    []
  );
  check("4 low-impact unknown, no configured rule => no Finding", candidate === null);
}

// 5-8. built-in high-impact unknown actions => HIGH_IMPACT_UNKNOWN
{
  const highImpact: ExecutionActionCategory[] = ["send", "delete", "share", "execute"];
  for (const actionCategory of highImpact) {
    const candidate = deriveRunsPermissionSecurityFindingCandidate(
      baseExecution({ actionCategory }),
      decision("unknown"),
      PERMISSION_DECISION_ID,
      []
    );
    check(`5-8 ${actionCategory} unknown => RUNS_REGISTERED_PERMISSION_UNKNOWN`, candidate?.findingType === "RUNS_REGISTERED_PERMISSION_UNKNOWN");
    check(`5-8 ${actionCategory} unknown => HIGH_IMPACT_UNKNOWN basis`, candidate?.eligibilityBasis === "HIGH_IMPACT_UNKNOWN");
    check(`5-8 ${actionCategory} unknown => configuredUnknownRuleId null`, candidate?.configuredUnknownRuleId === null);
  }
}

// 9. read unknown default (no configured rules) => no Finding
{
  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    baseExecution({ actionCategory: "read" }),
    decision("unknown"),
    PERMISSION_DECISION_ID
  );
  check("9 read unknown, default rule set => no Finding", candidate === null);
}

// 10. configured read unknown => CONFIGURED_UNKNOWN Finding
{
  const rule: ConfiguredUnknownAlertRule = { id: "rule-read-notion", actionCategory: "read", targetProvider: "notion" };
  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    baseExecution({ actionCategory: "read" }),
    decision("unknown"),
    PERMISSION_DECISION_ID,
    [rule]
  );
  check("10 configured read unknown => RUNS_REGISTERED_PERMISSION_UNKNOWN", candidate?.findingType === "RUNS_REGISTERED_PERMISSION_UNKNOWN");
  check("10 configured read unknown => CONFIGURED_UNKNOWN basis", candidate?.eligibilityBasis === "CONFIGURED_UNKNOWN");
  check("10 configured read unknown => configuredUnknownRuleId set", candidate?.configuredUnknownRuleId === "rule-read-notion");
  check("10 validates", validateSecurityFindingInput({ id: "x", ...candidate! }).ok === true);
}

// 10b. high-impact + configured match both => HIGH_IMPACT_UNKNOWN wins (section5)
{
  const rule: ConfiguredUnknownAlertRule = { id: "rule-send-notion", actionCategory: "send", targetProvider: "notion" };
  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    baseExecution({ actionCategory: "send" }),
    decision("unknown"),
    PERMISSION_DECISION_ID,
    [rule]
  );
  check("10b high-impact + configured both match => HIGH_IMPACT_UNKNOWN wins", candidate?.eligibilityBasis === "HIGH_IMPACT_UNKNOWN");
  check("10b HIGH_IMPACT_UNKNOWN wins => configuredUnknownRuleId stays null", candidate?.configuredUnknownRuleId === null);
}

// 11. multiple configured matches never guess (ambiguous => no Finding)
{
  const rules: ConfiguredUnknownAlertRule[] = [
    { id: "rule-a", actionCategory: "read" },
    { id: "rule-b", targetProvider: "notion" },
  ];
  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    baseExecution({ actionCategory: "read", targetProvider: "notion" }),
    decision("unknown"),
    PERMISSION_DECISION_ID,
    rules
  );
  check("11 multiple configured matches => fail closed, no Finding (never guess)", candidate === null);
}

// 12-13. downstream conflict => one Finding per conflict evidence row; two distinct ids => two Findings
{
  const conflictA = evidence({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", permissionState: "denied", observedAt: "2027-01-01T00:00:01.000Z" });
  const conflictB = evidence({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", permissionState: "denied", observedAt: "2027-01-02T00:00:00.000Z" });
  const consistent = evidence({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", permissionState: "allowed", observedAt: "2027-01-03T00:00:00.000Z" });
  const allEvidence = [conflictA, conflictB, consistent];
  const comparison = compareDownstreamPermissionEvidence({
    execution: baseExecution(),
    registeredPermissionResult: decision("allowed"),
    downstreamEvidence: allEvidence,
  });
  check("12/13 two CONFLICT rows detected by compare()", comparison.conflictEvidenceIds.length === 2);

  const candidates = deriveDownstreamPermissionSecurityFindingCandidates(baseExecution(), PERMISSION_DECISION_ID, comparison, allEvidence);
  check("12/13 one Finding candidate per conflicting evidence row (never collapsed)", candidates.length === 2);
  check("12/13 each candidate preserves its own downstreamPermissionEvidenceId", new Set(candidates.map((c) => c.downstreamPermissionEvidenceId)).size === 2);
  check("12/13 each candidate preserves permissionDecisionId too (DECISION D: both sources kept)", candidates.every((c) => c.permissionDecisionId === PERMISSION_DECISION_ID));
  check("12/13 consistent row never produces a Finding", !candidates.some((c) => c.downstreamPermissionEvidenceId === consistent.id));
  check("12/13 detectedAt uses the evidence's own observedAt, not execution time", candidates.find((c) => c.downstreamPermissionEvidenceId === conflictA.id)?.detectedAt === conflictA.observedAt);
  check("12/13 findingType is DOWNSTREAM_PERMISSION_CONFLICT", candidates.every((c) => c.findingType === "DOWNSTREAM_PERMISSION_CONFLICT"));
  check("12/13 eligibilityBasis is DOWNSTREAM_CONFLICT", candidates.every((c) => c.eligibilityBasis === "DOWNSTREAM_CONFLICT"));
  check("12/13 reasonCode is the fixed downstream vocabulary", candidates.every((c) => c.reasonCode === SECURITY_FINDING_REASON_CODES.DOWNSTREAM_PERMISSION_CONFLICT));
  for (const candidate of candidates) {
    check(`12/13 candidate ${candidate.downstreamPermissionEvidenceId} validates`, validateSecurityFindingInput({ id: "x", ...candidate }).ok === true);
  }
}

// 14. downstream unknown => no v0.1 Finding (section6/DECISION E: Downstream
// Permission Unknown stays an auditable SOR-8C comparison state only)
{
  const comparison = compareDownstreamPermissionEvidence({
    execution: baseExecution(),
    registeredPermissionResult: decision("allowed"),
    downstreamEvidence: [],
  });
  check("14 zero evidence => downstreamPermissionUnknown true (SOR-8C state)", comparison.downstreamPermissionUnknown === true);
  const candidates = deriveDownstreamPermissionSecurityFindingCandidates(baseExecution(), PERMISSION_DECISION_ID, comparison, []);
  check("14 downstream unknown never produces a v0.1 Finding", candidates.length === 0);
}

// 15. temporal relation never changes finding type (SOR-164 boundary, section23)
{
  const before = evidence({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", permissionState: "denied", observedAt: "2026-12-31T00:00:00.000Z" });
  const after = evidence({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", permissionState: "denied", observedAt: "2027-06-01T00:00:00.000Z" });
  const comparison = compareDownstreamPermissionEvidence({
    execution: baseExecution(),
    registeredPermissionResult: decision("allowed"),
    downstreamEvidence: [before, after],
  });
  check("15 both temporal directions produce CONFLICT identically", comparison.evidenceComparisons.every((c) => c.relationToRuns === "CONFLICT"));
  const candidates = deriveDownstreamPermissionSecurityFindingCandidates(baseExecution(), PERMISSION_DECISION_ID, comparison, [before, after]);
  check("15 temporal relation never changes findingType/eligibilityBasis", candidates.every((c) => c.findingType === "DOWNSTREAM_PERMISSION_CONFLICT" && c.eligibilityBasis === "DOWNSTREAM_CONFLICT"));
}

// 16. no unauthorized wording/boolean anywhere in the finding type/reason vocabulary
{
  const typesSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/types.ts"), "utf8");
  const forbidden = ["Unauthorized", "unauthorized", "Provider Denied", "Downstream Denied", "downstreamActionPermissionConflict"];
  check("16 no forbidden wording in securityFinding/types.ts", forbidden.every((word) => !typesSource.includes(word)));
  check("16 no boolean 'unauthorized' field anywhere in reason code vocabulary values", !Object.values(SECURITY_FINDING_REASON_CODES).some((code) => code.includes("unauthorized")));
}

// 17. no workId FIELD DECLARATION in Finding types (section20: Work
// independence). Checks for an actual property declaration (`workId:` /
// `workId?:`), not the word's appearance in a prose comment explaining
// that the field is absent.
{
  const typesSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/types.ts"), "utf8");
  check("17 no workId field declared anywhere in securityFinding/types.ts", !/\bworkId\??\s*:/.test(typesSource));
}

// 18. approval_required existing Attention derivation unchanged (Decision B/C)
{
  const candidate = deriveExecutionAttentionCandidate(
    baseExecution({ actorKind: "ai_agent", agentId: "agent-1", provider: "mcp", targetProvider: "notion" }),
    decision("approval_required", { reasonCode: "notion_m0_update_page_approval_required", policyId: "notion-ai-agent-update-page-approval-required" })
  );
  check("18 approval_required still produces an Attention candidate (unchanged path)", candidate !== null && candidate.reason === "approval_required");

  const deniedCandidate = deriveExecutionAttentionCandidate(baseExecution(), decision("denied"));
  check("18 denied no longer produces an Attention candidate via this function (moved to SecurityFinding path)", deniedCandidate === null);

  const unknownCandidate = deriveExecutionAttentionCandidate(baseExecution(), decision("unknown"));
  check("18 unknown still produces no Attention candidate via this function", unknownCandidate === null);
}

// 19. CaptureGap boundary — no capture-gap FIELD/COLUMN coupling
// introduced (section21). Checks for the actual coupling shape
// (`capture_gap_id` / `captureGapId` field, or importing the coverage/
// store as a VALUE), not prose that merely names CaptureGap to explain the
// boundary (which this module's own header comments intentionally do).
{
  const typesSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/types.ts"), "utf8");
  const storeSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/store.ts"), "utf8");
  const deriveSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/derive.ts"), "utf8");
  check("19 no capture_gap_id/captureGapId field anywhere in securityFinding module", ![typesSource, storeSource, deriveSource].some((src) => /capture_?gap_?id/i.test(src)));
  check("19 no value import from ../coverage/ (CaptureGap ledger) anywhere in securityFinding module", ![typesSource, storeSource, deriveSource].some((src) => /from\s+["']\.\.\/coverage/.test(src)));
}

// 20. Governance / SOR-138 boundary — no import from ../governance/, no public Preflight/Complete API
{
  const observeSource = readFileSync(join(__dirname, "../../../packages/runs-core/tact-execution/securityFinding/observe.ts"), "utf8");
  check("20 securityFinding/observe.ts does not import ../governance/", !observeSource.includes("../governance"));
}

// Static migration structure checks (mirrors sor8cDownstreamPermissionTest.ts's own migration assertions)
{
  const migrationPath = join(__dirname, "../supabase/migrations/20270101000015_create_tact_execution_security_findings.sql");
  const migration = readFileSync(migrationPath, "utf8");

  for (const required of [
    "tact_execution_security_findings",
    "'RUNS_REGISTERED_PERMISSION_MISMATCH'",
    "'RUNS_REGISTERED_PERMISSION_UNKNOWN'",
    "'DOWNSTREAM_PERMISSION_CONFLICT'",
    "foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id)",
    "foreign key (permission_decision_id, execution_id) references public.tact_execution_permission_decisions(id, execution_id)",
    "foreign key (downstream_permission_evidence_id, execution_id, user_id) references public.tact_execution_downstream_permission_evidence(id, execution_id, user_id)",
    "idx_security_findings_permission_source",
    "idx_security_findings_downstream_source",
    "tact_execution_attention_findings",
    "finding_id uuid primary key",
    "ensure_security_finding_attention_link",
    "security definer",
    "set search_path = public",
    "revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from public",
    "revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from anon",
    "revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from authenticated",
    "grant execute on function public.ensure_security_finding_attention_link(uuid, uuid) to service_role",
    "idx_tact_execution_attentions_active_per_execution",
    "'permission_mismatch', 'approval_required', 'permission_unknown', 'downstream_permission_conflict'",
    "enable row level security",
    "tact_execution_security_findings_select_own",
    "tact_execution_attention_findings_select_own",
  ]) {
    check(`migration contains: ${required}`, migration.includes(required));
  }

  // No UPDATE/DELETE API surface marker (no_update/delete policies, no
  // update/delete grant to anon/authenticated) anywhere in this file.
  check("migration defines no browser-facing update/delete policy", !/create policy[^;]*for\s+(update|delete|all)/i.test(migration));

  // Migrations 00001-00014 must remain untouched by this change — spot
  // check the three tables this migration references by composite FK.
  const permissionMigration = readFileSync(join(__dirname, "../supabase/migrations/20270101000003_create_tact_execution_permission.sql"), "utf8");
  check("migration 00003 untouched (no additive index/constraint lines added there)", !permissionMigration.includes("tact_execution_permission_decisions_id_execution_id_unique"));

  const downstreamMigration = readFileSync(join(__dirname, "../supabase/migrations/20270101000014_create_tact_execution_downstream_permission_evidence.sql"), "utf8");
  check("migration 00014 untouched", !downstreamMigration.includes("id_exec_user_unique"));

  const attentionMigration = readFileSync(join(__dirname, "../supabase/migrations/20270101000005_create_tact_execution_attentions.sql"), "utf8");
  check("migration 00005 still defines the original two-reason check (widened only in 00015, not rewritten in place)", attentionMigration.includes("check (reason in ('permission_mismatch', 'approval_required'))"));
}

console.log(`SOR8D_FOCUSED_TESTS=${checks.length}/${checks.length}`);
