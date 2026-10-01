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
