// =========================
// TACT Execution — Projection Repository Registry (SOR-135 Phase 1)
// =========================
//
// Runs Core's only point of contact with Work/Conversation-link data. This
// file imports nothing from Yolna (core/tact-work/**, core/tact-bot/**,
// core/tact-orchestrator/**, etc.) — only the product-neutral contract
// types (core/execution-contract). Importing this module, or anything in
// core/tact-execution/** that depends on it, must never require any Yolna
// secret (OPENAI_API_KEY/ANTHROPIC_API_KEY/COMPOSIO_API_KEY/TAVILY_API_KEY)
// to be present.
//
// A composition root OUTSIDE Runs Core (today: the compatibility adapter
// at core/tact-execution-yolna-adapter/, wired in from
// core/tact-bot/adapters/slack/observeSlackExecution.ts, the one real
// production caller of Work Correlation today) calls
// setWorkProjectionRepository()/setConversationLinkRepository() before any
// code path that actually needs to read Work/Conversation-link data runs.
// Merely importing core/tact-execution (or core/tact-runs-view) must never
// trigger this registration as a side effect — registration only happens
// when a real caller opts in.
//
// Fail-closed, not fail-silent: a correlation/resolution attempt made
// before registration throws a clear, actionable error instead of
// returning an empty/guessed result — consistent with this codebase's
// Never Guess Rule (do not fabricate "no Work found" when the real answer
// is "Runs was never told how to look").

import type {
  WorkProjectionRepository,
  ConversationLinkRepository,
  WorkReference,
} from "@tact/execution-contract";

let workProjectionRepository: WorkProjectionRepository | null = null;

let conversationLinkRepository: ConversationLinkRepository | null = null;

export function setWorkProjectionRepository(repository: WorkProjectionRepository): void {
  workProjectionRepository = repository;
}

export function setConversationLinkRepository(repository: ConversationLinkRepository): void {
  conversationLinkRepository = repository;
}

// テスト専用(絶対条件: 他テストの登録状態がleakしないようにする)。
export function resetProjectionRegistryForTest(): void {
  workProjectionRepository = null;
  conversationLinkRepository = null;
}

export function getWorkProjectionRepository(): WorkProjectionRepository {

  if (!workProjectionRepository) {
    throw new Error(
      "[tact-execution/projection/registry] No WorkProjectionRepository registered. " +
      "A composition root outside Runs Core must call setWorkProjectionRepository() " +
      "(e.g. core/tact-execution-yolna-adapter's registerYolnaProjectionAdapter()) " +
      "before invoking Work Correlation."
    );
  }

  return workProjectionRepository;

}

export function getConversationLinkRepository(): ConversationLinkRepository {

  if (!conversationLinkRepository) {
    throw new Error(
      "[tact-execution/projection/registry] No ConversationLinkRepository registered. " +
      "A composition root outside Runs Core must call setConversationLinkRepository() " +
      "(e.g. core/tact-execution-yolna-adapter's registerYolnaProjectionAdapter()) " +
      "before invoking Structural Correlation."
    );
  }

  return conversationLinkRepository;

}

// SOR-135 Phase 2: thin, named convenience wrappers around
// getWorkProjectionRepository() for the two reads Runs API routes need
// directly (title lookups for Activity/Correlation Review, Work Detail
// header). Both root Yolna's app/api/tact/runs/** and the standalone Runs
// application (products/yolna-runs) call these same two functions — they
// differ only in whether a repository has been registered. Unregistered
// (standalone, before a Runs-owned projection store exists — SOR-135
// Phase 3) means these throw, same as every other registry read; callers
// must fail closed (a clear "unavailable" response), never fabricate an
// empty/guessed result.

export async function getWorkViaRegistry(
  workId: string,
  userId: string,
  accessToken: string
): Promise<WorkReference | undefined> {
  return getWorkProjectionRepository().getWork(workId, userId, accessToken);
}

export async function listWorkTitlesByIdsViaRegistry(
  workIds: readonly string[],
  userId: string,
  accessToken: string
): Promise<Map<string, string | null>> {

  // An empty id set has nothing to look up — return the (trivially empty)
  // answer without requiring a repository to be registered, so callers
  // that have no Work-correlated rows yet never fail just for that reason.
  if (workIds.length === 0) {
    return new Map();
  }

  return getWorkProjectionRepository().listWorkTitlesByIds(workIds, userId, accessToken);

}
