// =========================
// TACT Canonical Execution — Security Finding (SOR-178 / SEC-8D)
// =========================
//
// Human Owner final architecture decisions (binding, see SOR-178 instructions):
//
// DECISION A: SecurityFinding is Execution-bound in v0.1. executionId is
// always non-null. CaptureGap (SOR-136, ../coverage/) is its own
// independent ledger and is never converted into a SecurityFinding here.
//
// DECISION B: approval_required is governance workflow, not a security
// violation. No APPROVAL_REQUIRED finding type exists. The existing
// approval_required Attention path (../permission/attention.ts /
// ../permission/attentionStore.ts) is untouched by this module.
//
// DECISION F: no severity/escalation engine. findingType + eligibilityBasis
// are the only classification this module makes.
//
// This is a product-neutral Runs Core domain module — no provider ACL
// connector, no SaaS credential, no DB-backed UNKNOWN policy engine. The
// configured-UNKNOWN rule set (below) is a small pure input contract a
// future caller may supply; the default production rule set is empty
// (section4, DECISION E).

import type { ExecutionActionCategory, ExecutionProvider } from "../types";

// =========================
// Taxonomy (section2 — exactly these three, nothing else)
// =========================

export type SecurityFindingType =
  | "RUNS_REGISTERED_PERMISSION_MISMATCH"
  | "RUNS_REGISTERED_PERMISSION_UNKNOWN"
  | "DOWNSTREAM_PERMISSION_CONFLICT";

export const SECURITY_FINDING_TYPES: readonly SecurityFindingType[] = [
  "RUNS_REGISTERED_PERMISSION_MISMATCH",
  "RUNS_REGISTERED_PERMISSION_UNKNOWN",
  "DOWNSTREAM_PERMISSION_CONFLICT",
];

export type SecurityFindingEligibilityBasis =
  | "DEFINITE_MISMATCH"
  | "HIGH_IMPACT_UNKNOWN"
  | "CONFIGURED_UNKNOWN"
  | "DOWNSTREAM_CONFLICT";

export const SECURITY_FINDING_ELIGIBILITY_BASES: readonly SecurityFindingEligibilityBasis[] = [
  "DEFINITE_MISMATCH",
  "HIGH_IMPACT_UNKNOWN",
  "CONFIGURED_UNKNOWN",
  "DOWNSTREAM_CONFLICT",
];

// Fixed, product-neutral reasonCode vocabulary (section5/section6 — never
// the underlying PermissionDecision/evidence's own free-form reasonCode;
// this is a stable, testable identifier of the FINDING's own nature).
export const SECURITY_FINDING_REASON_CODES = {
  RUNS_REGISTERED_PERMISSION_MISMATCH: "runs_registered_permission_mismatch",
  RUNS_REGISTERED_PERMISSION_UNKNOWN_HIGH_IMPACT: "runs_registered_permission_unknown_high_impact",
  RUNS_REGISTERED_PERMISSION_UNKNOWN_CONFIGURED: "runs_registered_permission_unknown_configured",
  DOWNSTREAM_PERMISSION_CONFLICT: "downstream_permission_conflict",
} as const;

export const SECURITY_FINDING_EVALUATOR_VERSION = "security-finding-v1";

// =========================
// SecurityFinding (persisted domain type, section3)
// =========================
//
// Absolute rules (section3): executionId non-null; permissionDecisionId
// non-null for ALL current finding types; downstreamPermissionEvidenceId is
// null for MISMATCH/UNKNOWN and required for DOWNSTREAM_PERMISSION_CONFLICT;
// configuredUnknownRuleId is required only for CONFIGURED_UNKNOWN and null
// otherwise; recordedAt is server-generated only. No workId. No Attention
// lifecycle state. No mutable status. No acknowledgement/resolution fields.
// No provider credential/access token/raw payload/unbounded metadata dump.

export interface SecurityFinding {

  id: string;

  userId: string;

  executionId: string;

  findingType: SecurityFindingType;

  reasonCode: string;

  eligibilityBasis: SecurityFindingEligibilityBasis;

  evaluatorVersion: string;

  detectedAt: string;

  recordedAt: string;

  permissionDecisionId: string;

  downstreamPermissionEvidenceId: string | null;

  configuredUnknownRuleId: string | null;

}

// Store-layer input (recordedAt is server-set, never caller-supplied —
// same convention as ../downstreamPermission/types.ts's
// DownstreamPermissionEvidenceInput).
export interface SecurityFindingInput extends Omit<SecurityFinding, "recordedAt"> {}

// =========================
// Pure derivation candidate (section5/section6)
// =========================
//
// derive.ts never generates an id — the caller (observe.ts) assigns a
// fresh caller-generated UUID immediately before persistence (section7:
// "Caller-generated UUID"), the same boundary split ../governance/ and
// ../downstreamPermission/ already use between their pure derivation and
// their store layer's id assignment.
export interface SecurityFindingCandidate extends Omit<SecurityFindingInput, "id"> {}

// =========================
// Read-model summary (section16 — minimal, no raw payload)
// =========================

export interface SecurityFindingSummary {

  findingId: string;

  findingType: SecurityFindingType;

  reasonCode: string;

  eligibilityBasis: SecurityFindingEligibilityBasis;

  detectedAt: string;

  permissionDecisionId: string;

  downstreamPermissionEvidenceId: string | null;

}

// =========================
// Configured UNKNOWN pure contract (section4, DECISION E)
// =========================
//
// No DB table in this slice. A field left null/undefined on a rule is a
// wildcard for that dimension — matching ../permission/types.ts's
// PermissionPolicyRule "*" wildcard convention, expressed the nullable-field
// way (../permission/types.ts's PermissionRegistryRule header comment: "DB
// column実際の型に合わせてnull = wildcardとする").
export interface ConfiguredUnknownAlertRule {

  id: string;

  provider?: ExecutionProvider | null;

  targetProvider?: ExecutionProvider | null;

  resourceType?: string | null;

  actionCategory?: ExecutionActionCategory | null;

}

// Default production rule set is empty (DECISION E, section4 — "Default
// configured rule set is empty").
export const DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES: readonly ConfiguredUnknownAlertRule[] = [];

// Built-in high-impact actions (section4/section5) — independent of any
// configured rule, never DB-backed.
export const HIGH_IMPACT_ACTION_CATEGORIES: readonly ExecutionActionCategory[] = [
  "send",
  "delete",
  "share",
  "execute",
];
