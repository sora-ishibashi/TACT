// =========================
// TACT Execution — Yolna Compatibility Adapter (SOR-135 Phase 1/2)
// =========================
//
// Temporary bridge between Yolna's existing Work/Conversation-link stores
// (core/tact-work/**, core/tact-bot/**) and the product-neutral
// WorkProjectionRepository/ConversationLinkRepository contracts
// (@tact/execution-contract) that Runs Core (@tact/runs-core's
// tact-execution, tact-runs-view) depends on.
//
// Placement matters: this file lives in the root Yolna application, OUTSIDE
// the packages/runs-core package — it is the only module allowed to import
// both Yolna's stores and Runs Core's projection registry
// (@tact/runs-core/tact-execution/projection/registry). Runs Core must
// never import this module (or core/tact-work, or core/tact-bot) directly;
// that is exactly the import-graph violation SOR-135 Phase 1 cuts. SOR-135
// Phase 2 additionally keeps this file OUT of the standalone Runs
// application (products/yolna-runs) entirely — it is Yolna-coupled by
// design and must never ship in a Runs-only install/build artifact. A
// composition root outside Runs Core wires this adapter in by calling
// registerYolnaProjectionAdapter() before any real Work Correlation runs.
//
// SOR-135 Phase 1 status (see completion report): none of
// @tact/runs-core's tact-execution/adapters/{slack,github,notion}/
// observe*Execution.ts are wired into a live production entrypoint yet
// (confirmed: no file under app/** or core/tact-bot/** calls them). There
// is therefore no existing composition root to attach
// registerYolnaProjectionAdapter() to without inventing new production
// wiring outside this task's scope — the adapter's own file headers already
// defer that wiring as explicit follow-up work. Call
// registerYolnaProjectionAdapter() once, early, from whichever module first
// wires a real observe*Execution adapter into a webhook/poll entrypoint.
//
// This file also re-exports Yolna's existing getWork()/listWorkTitlesByIds()
// unchanged (same Work-shaped return types) so app/api/tact/runs/** can stop
// importing "@/core/tact-work" directly without changing those routes'
// response shapes in the root Yolna application.

import {
  getWork,
  listWorksForConversation,
  listWorksForNotionResource,
  listRecentWorksForUser,
  listWorkTitlesByIds,
} from "../tact-work/store";
import { findConversationLink } from "../tact-bot/conversationLink/supabaseConversationLinkStore";
import type { Work } from "../tact-work/types";
import {
  setWorkProjectionRepository,
  setConversationLinkRepository,
} from "@tact/runs-core/tact-execution/projection/registry";
import type {
  WorkReference,
  WorkProjectionRepository,
  ConversationLinkReference,
  ConversationLinkRepository,
} from "@tact/execution-contract";

// Route/API-layer passthrough — unchanged Yolna-shaped functions/types.
export { getWork, listWorkTitlesByIds };

function toWorkReference(work: Work): WorkReference {
  return {
    id: work.id,
    title: work.title ?? null,
    status: work.status,
    conversationId: work.primaryConversationId ?? null,
  };
}

export const yolnaWorkProjectionRepository: WorkProjectionRepository = {

  async getWork(workId, userId, accessToken) {
    const work = await getWork(workId, userId, accessToken);
    return work ? toWorkReference(work) : undefined;
  },

  async listWorksForConversation(conversationId, userId, accessToken) {
    const works = await listWorksForConversation(conversationId, userId, accessToken);
    return works.map(toWorkReference);
  },

  async listWorksForNotionResource(resourceRef, userId, accessToken) {
    const works = await listWorksForNotionResource(resourceRef, userId, accessToken);
    return works.map(toWorkReference);
  },

  async listRecentWorksForUser(userId, accessToken, options) {
    const works = await listRecentWorksForUser(userId, accessToken, options);
    return works.map(toWorkReference);
  },

  listWorkTitlesByIds,

};

export const yolnaConversationLinkRepository: ConversationLinkRepository = {

  async findConversationLink(input): Promise<ConversationLinkReference | null> {
    const conversationId = await findConversationLink(input);
    return conversationId ? { conversationId } : null;
  },

};

let registered = false;

// Idempotent on purpose: multiple real entrypoints may each want to ensure
// registration happened before they run, without caring whether another
// entrypoint already did it.
export function registerYolnaProjectionAdapter(): void {

  if (registered) {
    return;
  }

  setWorkProjectionRepository(yolnaWorkProjectionRepository);
  setConversationLinkRepository(yolnaConversationLinkRepository);
  registered = true;

}

// Self-registers as a side effect of being imported at all. This module is
// explicitly OUTSIDE Runs Core and exists only to bridge to Yolna — unlike
// Runs Core itself, it is expected and safe for importing it to eagerly
// reach Yolna's stores. This means any caller (an app/api/tact/runs/**
// route today; a real webhook/poll entrypoint once one is wired, per this
// file's header) gets a working registry just by importing this module for
// its passthrough exports, without having to remember to also call
// registerYolnaProjectionAdapter() explicitly.
registerYolnaProjectionAdapter();
