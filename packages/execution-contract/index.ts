// =========================
// TACT Execution Contract (SOR-135 Phase 1/2)
// =========================
//
// Product-neutral schema/type/protocol shared between Yolna (execution
// plane: Agent/LLM/Orchestrator/Composio/SaaS write logic) and Yolna Runs
// (observation/governance/audit plane: packages/runs-core's tact-execution,
// tact-runs-view).
//
// SOR-10 Architecture Boundary Audit classified this as SHARED-CONTRACT:
// schema/type/protocol/DTO/validation only. This file must never import
// Yolna Agent runtime, LLM execution, Orchestrator, Composio, SaaS write
// logic, connector credential handling, Yolna DB access implementation,
// Yolna UI, or Yolna business logic (core/tact-work/**, core/tact-bot/**,
// core/tact-orchestrator/**, core/llm/**, etc.). It holds id/title/status/
// conversationId-shaped projections only — never business payload content,
// prompt text, or credentials.
//
// SOR-135 Phase 2: physically extracted to a real npm package
// (`@tact/execution-contract`, this directory) so a standalone Runs
// application (products/yolna-runs) and the root Yolna application can
// both depend on it as an ordinary `file:` dependency, with zero Yolna
// source tree required to install/build/typecheck it. Intended to become
// an independently publishable package (e.g. `@nayther/execution-contract`)
// once a second, non-monorepo consumer exists.

// =========================
// WorkReference — the minimal Work projection Runs needs for observation,
// Work correlation, and display. Deliberately NOT the full Yolna `Work`
// entity (core/tact-work/types.ts) — only id/title/status/conversationId,
// per SOR-135's "Shared Contractへ入れてはいけないもの" boundary.
// =========================

export interface WorkReference {

  id: string;

  title: string | null;

  // Intentionally a plain string, not a closed union: Runs Core only ever
  // compares this against its own literal status-name lists (e.g. a
  // terminal-status set) and must not depend on Yolna's WorkStatus type.
  status: string;

  conversationId: string | null;

}

// SOR-135 Phase 2: a documented, non-exhaustive vocabulary of Work status
// values Runs Core/View already know how to label (lifted verbatim from
// Yolna's WorkStatus union, which was itself generic workflow-lifecycle
// vocabulary, not Yolna-proprietary business terms). This is NOT a closed
// type (WorkReference.status stays `string`) — it exists only so a
// product-neutral UI (e.g. packages/runs-core's tact-runs-view) can render
// a human label for the common case without importing Yolna's own
// WorkStatus type, while still falling back safely for any unrecognized
// status string (never throwing, never guessing a label).
export const KNOWN_WORK_STATUSES = [
  "created",
  "planning",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type KnownWorkStatus = (typeof KNOWN_WORK_STATUSES)[number];

// =========================
// ConversationLinkReference — the result of resolving an external
// (e.g. Slack channel/thread) conversation link to a TACT conversation id.
// =========================

export interface ConversationLinkReference {

  conversationId: string;

}

export interface ConversationLinkLookupInput {

  // Only "slack" is a real caller today (core/tact-execution/correlation/
  // stages/structural.ts). Extend this union, not its shape, when a second
  // channel's Structural Correlator is added.
  channel: "slack";

  externalWorkspaceId?: string;

  externalConversationId: string;

  externalThreadId?: string;

}

export interface ListRecentWorksForUserOptions {

  limit?: number;

}

// =========================
// WorkProjectionRepository — the only way Runs Core may read Work data.
// Runs Core (core/tact-execution/**, core/tact-runs-view/**) depends on
// this interface only; it never imports core/tact-work directly. A
// temporary compatibility adapter living OUTSIDE Runs Core
// (core/tact-execution-yolna-adapter/) implements it against Yolna's
// existing tact-work store for this phase (SOR-135 Phase 1).
//
// Method shapes intentionally mirror core/tact-work/store.ts's existing
// read functions (same parameter order/meaning) so the compatibility
// adapter is a thin, behavior-preserving wrapper rather than a redesign.
// =========================

export interface WorkProjectionRepository {

  getWork(workId: string, userId: string, accessToken: string): Promise<WorkReference | undefined>;

  listWorksForConversation(conversationId: string, userId: string, accessToken: string): Promise<WorkReference[]>;

  listWorksForNotionResource(resourceRef: string, userId: string, accessToken: string): Promise<WorkReference[]>;

  listRecentWorksForUser(
    userId: string,
    accessToken: string,
    options?: ListRecentWorksForUserOptions
  ): Promise<WorkReference[]>;

  // SOR-135 Phase 2: mirrors core/tact-work/store.ts's listWorkTitlesByIds()
  // (tenant-safe batch title lookup). Added so Runs API routes that only
  // need a title join (Activity/Correlation Review) can go through this
  // interface instead of a product-specific passthrough — see
  // packages/runs-core's tact-execution/projection/registry.ts.
  listWorkTitlesByIds(
    workIds: readonly string[],
    userId: string,
    accessToken: string
  ): Promise<Map<string, string | null>>;

}

// =========================
// ConversationLinkRepository — the only way Runs Core may resolve an
// external channel conversation link. Mirrors core/tact-bot/conversationLink/
// supabaseConversationLinkStore.ts's findConversationLink() shape.
// =========================

export interface ConversationLinkRepository {

  findConversationLink(input: ConversationLinkLookupInput): Promise<ConversationLinkReference | null>;

}

// =========================
// JsonValue — generic JSON type, product-neutral. SOR-135 Phase 2: moved
// here from core/tact-work/approvalIntegrity.ts (where Runs Core's
// type-only reference to it was flagged in Phase 1 as a future
// shared-contract candidate). Runs Core's own JSON-shaped columns
// (source_metadata, candidate metadata, etc.) use this definition; Yolna's
// copy in core/tact-work/approvalIntegrity.ts is structurally identical
// and unaffected by this move (not imported from here, to avoid making
// Yolna depend on this package for an unrelated reason).
// =========================

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// =========================
// Yolna -> Runs Projection Contract (SOR-135 Phase 3)
// =========================
//
// The write-side counterpart to WorkProjectionRepository/
// ConversationLinkRepository above. Where those two interfaces are "how
// Runs Core reads Work/Conversation-link data" (implemented once per
// deployment: the root app's core/tact-execution-yolna-adapter, or the
// standalone app's own Postgres-backed projection store), these two are
// "how Yolna tells a Runs projection store about a Work/Conversation-link
// it knows about" — the explicit telemetry/projection boundary SOR-135
// section 8 calls for, instead of a live cross-database join.
//
// This phase defines the contract and a real standalone implementation
// (products/yolna-runs's own projection writer, backed by its own
// Postgres) but does not wire Yolna's production code to call it over a
// network — no deployment topology exists yet for that call to cross a
// real process/database boundary (SOR-135 Phase 4+). The root app
// continues reading Work data through core/tact-execution-yolna-adapter's
// live query against its own tact-work store for now; this contract is
// the seam a future phase connects on the write side once Runs has its
// own reachable endpoint to call.
//
// Data minimization (absolute condition, same as every other type in this
// file): these DTOs may carry identity/reference/title/status/correlation
// metadata only. Never prompt text, message/document bodies, credentials,
// or OAuth/SaaS tokens — there is deliberately no field for any of that,
// so adding one is a visible, reviewable change to this file, not a
// silent runtime decision.

export interface WorkProjectionUpsertInput {

  externalWorkId: string;

  userId: string;

  title: string | null;

  status: string;

  conversationReference: string | null;

}

export interface WorkProjectionWriter {

  // Upsert is the only write primitive — there is no separate "create" vs
  // "update": a projection row either reflects the Work's current
  // identity/title/status/conversation reference, or it does not exist
  // yet (handled as "unknown" by every reader, never fabricated — see
  // WorkProjectionRepository's own header comment).
  upsertWork(input: WorkProjectionUpsertInput): Promise<void>;

}

export interface ConversationLinkProjectionUpsertInput {

  userId: string;

  channel: "slack";

  externalWorkspaceId?: string;

  externalConversationId: string;

  externalThreadId?: string;

  conversationReference: string;

}

export interface ConversationLinkProjectionWriter {

  upsertConversationLink(input: ConversationLinkProjectionUpsertInput): Promise<void>;

}

// =========================
// Preflight / Complete — Provider-neutral Governance Wire Contract (SOR-138 Slice 1)
// =========================
//
// Shared between a future Yolna-side caller and Yolna Runs
// (packages/runs-core/tact-execution/governance/contract.ts — the only
// implementation in Slice 1). Maps onto the already-landed SOR-8B
// GovernanceInvocation/GovernanceDecision model (packages/runs-core's
// tact-execution/governance/types.ts) without exposing that model's
// internal DB row shapes here.
//
// Vocabulary strings (actorKind/actionCategory/provider/sourceType/
// outcome status) are plain `string`-typed below, not imported closed
// unions, so this package keeps zero runtime or type dependency on
// @tact/runs-core (the dependency direction is runs-core -> this
// package, never the reverse). Each value is validated against Runs' own
// closed vocabulary at the implementation boundary and rejected
// explicitly when unrecognized — never silently coerced or defaulted.
// No Composio/Slack/Notion/LLM-specific field exists here, only the
// generic actor/action/provider vocabulary every adapter already
// normalizes execution events into.

export type PreflightVerdict = "ALLOW" | "DENY" | "APPROVAL_REQUIRED" | "UNKNOWN";

export const PREFLIGHT_VERDICTS: readonly PreflightVerdict[] = ["ALLOW", "DENY", "APPROVAL_REQUIRED", "UNKNOWN"];

export interface PreflightRequest {

  // Caller-supplied idempotency identity (maps to GovernanceInvocation.id).
  // Resubmitting the same invocationId with identical content is always
  // safe; resubmitting it with different content is rejected explicitly,
  // never silently overwritten or merged.
  invocationId: string;

  // Deliberately NO userId/tenant-identity field here (Human Owner
  // correction, SOR-138 Slice 1 security re-review): tenant identity must
  // never be self-asserted by a wire payload. The implementation
  // (packages/runs-core/tact-execution/governance/contract.ts's
  // preflight()) takes the acting user's id as its own separate,
  // trusted function argument — supplied by whatever authenticated
  // server/adapter boundary calls preflight(), the same pattern
  // complete() already uses for its own `userId` argument. Adding a
  // userId-shaped field back to this interface is a visible, reviewable
  // change to this file, not something a caller can smuggle in.

  organizationId?: string | null;

  workspaceId?: string | null;

  workId?: string | null;

  connectionId?: string | null;

  // Runs' own ExecutionActorKind vocabulary ("human" | "ai_agent" |
  // "service" | "connector" | "system"), validated at the boundary.
  actorKind: string;

  actorId?: string | null;

  agentId?: string | null;

  onBehalfOfActorKind?: string | null;

  onBehalfOfActorId?: string | null;

  // Runs' own ExecutionActionCategory vocabulary ("read" | "create" |
  // "update" | "send" | "delete" | "share" | "execute" | "approve" |
  // "unknown"), validated at the boundary.
  actionCategory: string;

  operation: string;

  resourceType?: string | null;

  resourceIdentifier?: string | null;

  // Runs' own closed ExecutionProvider vocabulary, validated at the
  // boundary (never coerced/guessed when unrecognized).
  targetProvider?: string | null;

  // ISO-8601 with an explicit timezone offset.
  attemptedAt: string;

}

export interface PreflightResponse {

  decisionId: string;

  invocationId: string;

  verdict: PreflightVerdict;

  reasonCode: string;

  evaluatorVersion: string;

  // = GovernanceDecision.policySetFingerprint: a SHA-256 digest of the
  // enabled, time-effective Permission Registry rule set this verdict was
  // computed against.
  policyVersion: string;

  matchedRuleIdentifier: string | null;

  // SOR-138 Slice 1: always null/null (nothing resolved a human approval
  // yet). SOR-138 Slice 2A: populated once a durable GovernanceApprovalRequest
  // exists for an APPROVAL_REQUIRED verdict — approvalId is present as soon
  // as the request exists (even while still pending), and status stays null
  // until it resolves.
  //
  // IMPORTANT — this field reports the RECORDED HUMAN DECISION only. It is
  // NOT sufficient authorization to execute:
  //   - status === "approved" is not an execution token, lease, or grant.
  //   - it is not replay-safe, not one-shot, not target-bound, and not
  //     transaction-bound — nothing here proves the approved action and the
  //     action actually attempted later are the same action against the
  //     same target/value/state.
  //   - verdict above never changes because of this field. An
  //     APPROVAL_REQUIRED verdict stays APPROVAL_REQUIRED forever on this
  //     decision, resolved or not — approval/rejection is a fact about a
  //     separate record, not a verdict rewrite.
  // Replay protection, expiry, and transaction/target binding are explicitly
  // out of this contract slice (tracked against SOR-160/SOR-164/SOR-169 and
  // later live-mediation work) — do not infer any of them from this shape.
  approval: { approvalId: string | null; status: "approved" | "rejected" | null };

}

export interface CompleteRequestExecutionEvidence {

  // Runs' own closed ExecutionProvider vocabulary, validated at the
  // boundary.
  provider: string;

  // Runs' own closed ExecutionSourceType vocabulary, validated at the
  // boundary.
  sourceType: string;

  // Idempotency key for the resulting Canonical Execution capture, same
  // role as every other adapter's externalEventId.
  externalEventId: string;

  adapterVersion: string;

  // Runs' own closed ExecutionStatus vocabulary, validated at the
  // boundary when present.
  status?: string;

  errorCode?: string | null;

  errorMessage?: string | null;

  resourceType?: string | null;

  resourceIdentifier?: string | null;

  providerOccurredAt?: string | null;

}

export interface CompleteRequestOutcome {

  // Runs' own closed ExecutionOutcomeStatus vocabulary ("unknown" |
  // "asserted"), validated at the boundary.
  status: string;

  outcomeKind?: string | null;

  summary?: string | null;

  // Runs' own closed ExecutionOutcomeMethod vocabulary ("adapter_asserted"
  // | "manual_override"). Defaults to "adapter_asserted" when omitted.
  method?: string;

}

export interface CompleteRequest {

  decisionId: string;

  invocationId: string;

  // Trust is never carried as a wire field here — see
  // governance/contract.ts's header comment. It is established entirely
  // by which `capture` dependency the caller of complete() is allowed to
  // inject, exactly as the existing telemetry-ingest route already
  // authenticates a caller before it is allowed to reach captureExecution().
  execution: CompleteRequestExecutionEvidence;

  outcome?: CompleteRequestOutcome | null;

}

export type CompleteResultStatus =
  | "linked"
  | "already_linked"
  | "link_conflict"
  | "invocation_not_found"
  | "decision_not_found"
  | "invalid"
  | "unavailable"
  | "error";

export interface CompleteResult {

  status: CompleteResultStatus;

  executionId?: string;

  governanceExecutionLinkId?: string;

  outcomeRecorded?: boolean;

  reason?: string;

}

// =========================
// Connection Projection Contract (SOR-212)
// =========================
//
// The write/read-side counterpart, for Connection, to
// WorkProjectionWriter/WorkProjectionRepository above — but a FULL
// SNAPSHOT projection, not an event-only upsert, for a reason specific to
// Connection: a projection table that has never received anything and a
// projection table whose canonical source genuinely has zero Connections
// must be distinguishable from each other. An event-only upsert stream
// cannot express "I checked, and there are truly none" — only a full
// snapshot (plus an explicit "has at least one snapshot ever completed"
// marker, see ConnectionProjectionSnapshotState below) can. This is the
// same "Never Guess Rule" this package applies everywhere else, applied to
// the read-side's own initialization state rather than to a single field.
//
// Canonical source: root Yolna's core/tact-integration/connection.ts
// (Connection, core/tact-integration/types.ts) and its tact_connections
// table. Runs (both the embedded app/api/tact/runs/** under the root app
// and the standalone products/yolna-runs deployment) must never import
// core/tact-integration or query tact_connections directly — this contract
// is the only sanctioned crossing point, exactly like the Work/
// ConversationLink contract above.
//
// Absolute condition — FORBIDDEN fields (never add any of these to any
// type in this section; doing so is a visible, reviewable change to this
// file, not a silent runtime decision, same discipline as the rest of this
// file):
//   providerConnectionRef, metadata, providerStatusRaw, token,
//   accessToken, refreshToken, credential, secret, redirectUrl, and any
//   Composio Connected Account ID. None of these ever cross this contract
//   in either direction.

// Mirrors core/tact-integration/types.ts's ConnectionStatus exactly.
// Declared independently here (this package's own established
// convention — see e.g. this file's actor/action/provider vocabulary
// comments above) rather than imported, so this package keeps zero
// runtime/type dependency on root Yolna's source tree.
export type ConnectionProjectionStatus = "pending" | "active" | "failed" | "revoked";

export const CONNECTION_PROJECTION_STATUSES: readonly ConnectionProjectionStatus[] = [
  "pending",
  "active",
  "failed",
  "revoked",
];

// One Connection, reduced to the minimum shape Runs may ever see. `service`
// and `provider` are plain strings (not imported closed unions), the same
// "Runs Core stays Yolna-vocabulary-free" reasoning as WorkReference.status
// above — a reader renders an unrecognized value as itself, never guesses
// or throws.
export interface ConnectionProjectionItem {

  // = canonical Connection.id (root Yolna). Named externalConnectionId
  // here (not id) for the same reason WorkProjectionUpsertInput uses
  // externalWorkId — this value is an opaque foreign reference from Runs'
  // point of view, not a Runs-owned primary key semantic.
  externalConnectionId: string;

  service: string;

  status: ConnectionProjectionStatus;

  provider: string;

  createdAt: string;

  updatedAt: string;

}

export interface ConnectionProjectionSnapshotInput {

  userId: string;

  // When this snapshot was taken (producer-asserted, server-side — see
  // core/tact-integration/connectionProjection.ts). Distinct from any
  // per-row createdAt/updatedAt, which describe the underlying Connection
  // rows, not the act of snapshotting them.
  snapshotAt: string;

  // The FULL current list for this user, not a delta. A Connection that
  // existed in a previous snapshot but is absent here is understood by the
  // writer to no longer exist in this snapshot (see
  // ConnectionProjectionWriter.replaceSnapshot's own comment) — but
  // canonical Connection rows are never physically deleted (status
  // transitions to "revoked" instead), so in practice this list's size is
  // monotonically non-decreasing for a healthy producer.
  connections: ConnectionProjectionItem[];

}

// Absolute condition (this section's whole reason for existing): a reader
// MUST be able to tell "no snapshot has ever completed for this user" apart
// from "the latest completed snapshot legitimately contained zero
// Connections". "unavailable" is the former; "available" is the latter
// (including the empty-list case) — never derived from
// `connections.length === 0` alone.
export type ConnectionProjectionReadState = "unavailable" | "available";

export interface ConnectionProjectionSnapshotState {

  readState: ConnectionProjectionReadState;

  // null when readState === "unavailable". Otherwise the snapshotAt value
  // from the most recently successfully completed snapshot (see
  // ConnectionProjectionWriter.replaceSnapshot's ordering guarantee).
  lastSnapshotAt: string | null;

}

export interface ConnectionProjectionRepository {

  getSnapshotState(userId: string): Promise<ConnectionProjectionSnapshotState>;

  // Only meaningful once getSnapshotState(userId).readState === "available"
  // — a caller that has not checked readState first must not treat this
  // return value as authoritative (an implementation may return [] either
  // way rather than throwing; the caller owns the readState check, exactly
  // like every other "unknown vs. empty" boundary in this package).
  listConnectionsForUser(userId: string): Promise<ConnectionProjectionItem[]>;

}

export interface ConnectionProjectionWriter {

  // Full-snapshot replace, not an incremental upsert (see this section's
  // header comment for why Connection differs from Work/ConversationLink
  // above). An implementation MUST only advance the readable snapshot
  // state (what getSnapshotState/listConnectionsForUser report) after the
  // full replace has itself succeeded — a partially-written snapshot must
  // never become visible, and a failed snapshot must never retire the
  // previous successful one (fail-closed, not fail-forward).
  replaceSnapshot(input: ConnectionProjectionSnapshotInput): Promise<void>;

}
