// =========================
// TACT Bot — Pending Approval Thread Resolution Regression (S1e)
// =========================
//
// 対象: core/tact-bot/execution/resolvePendingApprovalForThread.ts。
// 実Supabaseには一切接続しない(ResolvePendingApprovalForThreadDeps
// 経由でStore呼び出しを偽実装に差し替える)。

import {
  resolvePendingApprovalForThread,
  type ResolvePendingApprovalForThreadDeps,
} from "../../../core/tact-bot/execution/resolvePendingApprovalForThread";
import type { Approval } from "../../../core/tact-work/types";
import type { Conversation } from "../../../core/tact-conversation/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "integration.slack.send_message",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status: "pending",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-10T00:00:00.000Z",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    userId: "user-1",
    title: null,
    workId: "work-1",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResolvePendingApprovalForThreadDeps> = {}): {
  deps: ResolvePendingApprovalForThreadDeps;
  calls: {
    findConversationLinkCalls: number;
    getConversationCalls: number;
    listApprovalsForWorkCalls: number;
  };
} {

  const calls = { findConversationLinkCalls: 0, getConversationCalls: 0, listApprovalsForWorkCalls: 0 };

  const deps: ResolvePendingApprovalForThreadDeps = {

    getServiceRoleKey: () => "fake-service-role-key",

    findConversationLink: async () => {
      calls.findConversationLinkCalls += 1;
      return "conv-1";
    },

    getConversation: async () => {
      calls.getConversationCalls += 1;
      return makeConversation();
    },

    listApprovalsForWork: async () => {
      calls.listApprovalsForWorkCalls += 1;
      return [makeApproval()];
    },

    ...overrides,

  };

  return { deps, calls };

}

const baseParams = {
  tactUserId: "user-1",
  channel: "slack" as const,
  externalConversationId: "C1",
  externalThreadId: "TS1",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- trusted_execution_not_configured: service role key未設定 -> DBへ一切アクセスしない ----
  {
    const { deps, calls } = makeDeps({ getServiceRoleKey: () => null });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[trusted_execution_not_configured] service role key未設定の場合、trusted_execution_not_configuredを返し、DBへ一切アクセスしない",
        result.status === "trusted_execution_not_configured" &&
          calls.findConversationLinkCalls === 0 &&
          calls.getConversationCalls === 0 &&
          calls.listApprovalsForWorkCalls === 0
      )
    );
  }

  // ---- conversation_link_missing ----
  {
    const { deps, calls } = makeDeps({ findConversationLink: async () => null });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[conversation_link_missing] thread相関が見つからない場合、conversation_link_missingを返し、getConversation/listApprovalsForWorkへは進まない",
        result.status === "conversation_link_missing" &&
          calls.getConversationCalls === 0 &&
          calls.listApprovalsForWorkCalls === 0
      )
    );
  }

  // ---- work_missing: Conversation自体が見つからない ----
  {
    const { deps, calls } = makeDeps({ getConversation: async () => undefined });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[work_missing] Conversationが見つからない(所有権不一致含む)場合、work_missingを返す、listApprovalsForWorkへは進まない",
        result.status === "work_missing" && calls.listApprovalsForWorkCalls === 0
      )
    );
  }

  // ---- work_missing: Conversation.workIdがnull ----
  {
    const { deps } = makeDeps({ getConversation: async () => makeConversation({ workId: null }) });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[work_missing] Conversation.workIdがnullの場合もwork_missingを返す",
        result.status === "work_missing"
      )
    );
  }

  // ---- no_pending_approval: pending 0件 ----
  {
    const { deps } = makeDeps({
      listApprovalsForWork: async () => [makeApproval({ status: "approved" }), makeApproval({ status: "rejected", id: "approval-2" })],
    });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[no_pending_approval] pending状態のApprovalが1件も無い場合、no_pending_approvalを返す",
        result.status === "no_pending_approval"
      )
    );
  }

  // ---- resolved: pending 1件 -> そのApprovalを返す ----
  {
    const { deps } = makeDeps({
      listApprovalsForWork: async () => [makeApproval({ id: "approval-solo", status: "pending" })],
    });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[resolved] pendingのApprovalが正確に1件の場合、resolvedとしてそのApproval/workIdを返す",
        result.status === "resolved" && result.workId === "work-1" && result.approval.id === "approval-solo"
      )
    );
  }

  // ---- ambiguous_pending_approval: pending 2件以上 -> 「最新の1件を勝手に選ぶ」ことをしない ----
  {
    const pendingApprovals = [
      makeApproval({ id: "approval-a", status: "pending", requestedAt: "2026-09-10T00:00:00.000Z" }),
      makeApproval({ id: "approval-b", status: "pending", requestedAt: "2026-09-10T00:05:00.000Z" }),
    ];

    const { deps } = makeDeps({ listApprovalsForWork: async () => pendingApprovals });

    const result = await resolvePendingApprovalForThread(baseParams, deps);

    results.push(
      check(
        "[ambiguous_pending_approval] pendingのApprovalが2件以上の場合、ambiguous_pending_approval(count=2)を返し、どちらか一方を勝手に選ばない",
        result.status === "ambiguous_pending_approval" && result.count === 2
      )
    );
  }

  // ---- identity: tactUserIdがgetConversation/listApprovalsForWorkへそのまま渡る(server側で解決済みの値のみを使う) ----
  {
    let capturedGetConversationUserId: string | undefined;
    let capturedListApprovalsUserId: string | undefined;

    const { deps } = makeDeps({
      getConversation: async (_id, userId) => {
        capturedGetConversationUserId = userId;
        return makeConversation();
      },
      listApprovalsForWork: async (_workId, userId) => {
        capturedListApprovalsUserId = userId;
        return [makeApproval()];
      },
    });

    await resolvePendingApprovalForThread({ ...baseParams, tactUserId: "trusted-user-42" }, deps);

    results.push(
      check(
        "[identity] getConversation()/listApprovalsForWork()へ渡るuserIdは、呼び出し元が渡したtactUserId('trusted-user-42')そのもの(server側で解決済みの値のみを使う)",
        capturedGetConversationUserId === "trusted-user-42" && capturedListApprovalsUserId === "trusted-user-42"
      )
    );
  }

  return summarize("bot/resolvePendingApprovalForThread", results);

}
