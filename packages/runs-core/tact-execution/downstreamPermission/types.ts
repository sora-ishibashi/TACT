// =========================
// TACT Canonical Execution — Downstream Permission Evidence (SOR-177 / SEC-8C)
// =========================
//
// Core Principle (Human Owner, SOR-177 design decision, APPROVED WITH
// REFINEMENTS): this is a fourth, independent fact, alongside the three the
// repository already keeps apart — Observed Action (../types.ts), Runs
// Registered Permission (../permission/types.ts), and pre-execution Runs
// Governance (../governance/types.ts). Downstream Permission Evidence is
// what an external/downstream system actually says about a permission, as
// distinct from what Runs' own registry says and what Runs decided before
// acting. This file does not add fields to, or get summarized onto, any of
// those three existing layers.
//
// Trust vs Authority (absolute condition, Human Owner section5): these are
// two independent axes, never collapsed into one mixed enum.
//   - trustLevel answers "how strongly do we trust/authenticate this
//     evidence SOURCE" — reuses the existing UNTRUSTED/AUTHENTICATED/
//     INTERNAL vocabulary (tact_telemetry_sources.trust_level,
//     governance/types.ts's trustLevelSnapshot). Declared independently here
//     rather than imported, following this repository's existing
//     convention that each module owns its own small vocabulary
//     (tact-execution/validation.ts header comment).
//   - authorityLevel answers "can this source speak FOR the downstream
//     provider's own permission state". AUTHENTICATED does not imply
//     AUTHORITATIVE. AUTHORITATIVE must be explicitly asserted by a trusted
//     internal adapter — it is never inferred from trustLevel.
//
// Source provenance (sourceType/sourceIdentifier, free-form strings) and
// authority strength (authorityLevel) are orthogonal (Human Owner section3
// refinement) — do not fold them into one mixed enum such as
// AUTHORITATIVE_ACL/ASSERTED_BY_CONNECTOR/SELF_REPORTED_BY_ACTOR/
// UNKNOWN_AUTHORITY. No provider-specific sourceType values are hard-coded
// into Core here (no ACL connectors are built in SOR-8C).

import type { JsonValue } from "@tact/execution-contract";
import type { ExecutionActionCategory, ExecutionActorKind, ExecutionProvider } from "../types";

export type DownstreamPermissionState = "allowed" | "denied" | "unknown";

export const DOWNSTREAM_PERMISSION_STATES: readonly DownstreamPermissionState[] = [
  "allowed",
  "denied",
  "unknown",
];

export type DownstreamEvidenceAuthorityLevel = "AUTHORITATIVE" | "NON_AUTHORITATIVE" | "UNKNOWN";

export const DOWNSTREAM_EVIDENCE_AUTHORITY_LEVELS: readonly DownstreamEvidenceAuthorityLevel[] = [
  "AUTHORITATIVE",
  "NON_AUTHORITATIVE",
  "UNKNOWN",
];

// 既存tact_telemetry_sources.trust_level / governance/types.tsの
// trustLevelSnapshotと同じ値集合。共有importはしない(各moduleが自分の
// vocabularyを持つ既存規約、tact-execution/validation.ts冒頭コメント参照)。
export type DownstreamEvidenceTrustLevel = "UNTRUSTED" | "AUTHENTICATED" | "INTERNAL";

export const DOWNSTREAM_EVIDENCE_TRUST_LEVELS: readonly DownstreamEvidenceTrustLevel[] = [
  "UNTRUSTED",
  "AUTHENTICATED",
  "INTERNAL",
];

// =========================
// DownstreamPermissionEvidence (persisted domain type)
// =========================

export interface DownstreamPermissionEvidence {

  id: string;

  userId: string;

  executionId: string;

  targetProvider: ExecutionProvider;

  connectionId: string | null;

  subjectKind: ExecutionActorKind;

  subjectId: string | null;

  // SOR-177 Human Owner section4(絶対条件): Runs Permission Registryが
  // agentId単位でscopeできる(../permission/registryEvaluate.tsの
  // matchesRegistryRule()のrequiresKnownAgentId/agentId厳格一致)のと同じ
  // 理由で、同一principal配下の複数agentをここで暗黙にconflateしない。
  agentId: string | null;

  actionCategory: ExecutionActionCategory;

  operation: string;

  resourceType: string | null;

  resourceIdentifier: string | null;

  permissionState: DownstreamPermissionState;

  sourceType: string;

  sourceIdentifier: string | null;

  authorityLevel: DownstreamEvidenceAuthorityLevel;

  trustLevel: DownstreamEvidenceTrustLevel;

  // このevidence自身が「いつ正しかったか」(source視点の時刻)。SOR-164が
  // 将来transaction-bound authorizationの契約を確立するまでは、これを
  // Execution実行時点の権限と等値視しない(絶対条件、section14/15 —
  // 「permission at execution time」を主張しない)。
  observedAt: string;

  // server/DB側が常に書き込む、永続化時刻。caller-suppliedではない
  // (絶対条件、section4)。
  recordedAt: string;

  evidenceSnapshot: JsonValue | null;

}

// =========================
// DownstreamPermissionEvidenceInput (store層への入力、recordedAtを含まない)
// =========================

export interface DownstreamPermissionEvidenceInput {

  id: string;

  userId: string;

  executionId: string;

  targetProvider: ExecutionProvider;

  connectionId?: string | null;

  subjectKind: ExecutionActorKind;

  subjectId?: string | null;

  agentId?: string | null;

  actionCategory: ExecutionActionCategory;

  operation: string;

  resourceType?: string | null;

  resourceIdentifier?: string | null;

  permissionState: DownstreamPermissionState;

  sourceType: string;

  sourceIdentifier?: string | null;

  authorityLevel: DownstreamEvidenceAuthorityLevel;

  trustLevel: DownstreamEvidenceTrustLevel;

  observedAt: string;

  evidenceSnapshot?: JsonValue | null;

}

export type { JsonValue };
