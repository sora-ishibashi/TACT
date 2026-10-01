// =========================
// TACT Execution Contract (SOR-135 Phase 1)
// =========================
//
// Product-neutral schema/type/protocol shared between Yolna (execution
// plane: Agent/LLM/Orchestrator/Composio/SaaS write logic) and Yolna Runs
// (observation/governance/audit plane: core/tact-execution/**,
// core/tact-runs-view/**).
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
// Intended to become an independently publishable package
// (e.g. `@nayther/execution-contract`) once a second consumer exists
// (SOR-135 Phase 2+). Until then it lives at this path so both Yolna and
// Yolna Runs can import it without a workspace/package boundary change.

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

}

// =========================
// ConversationLinkRepository — the only way Runs Core may resolve an
// external channel conversation link. Mirrors core/tact-bot/conversationLink/
// supabaseConversationLinkStore.ts's findConversationLink() shape.
// =========================

export interface ConversationLinkRepository {

  findConversationLink(input: ConversationLinkLookupInput): Promise<ConversationLinkReference | null>;

}
