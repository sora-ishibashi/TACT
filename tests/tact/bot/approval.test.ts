// =========================
// TACT Bot — Approval Translation Boundary Regression
// (Architecture Migration Phase B3)
// =========================
//
// 対象: core/tact-bot/approval.tsのtoBotRequestApprovalAction()
// (純粋関数、DBアクセスなし)。Canonical Approval(core/tact-work/)を
// BotRequestApprovalAction(core/tact-bot/types.ts)へ変換するだけの
// translationであり、Approval状態自体を複製・保存しないことを確認する。

import { toBotRequestApprovalAction } from "../../../core/tact-bot/approval";
import type { Approval } from "../../../core/tact-work/types";
import type { BotActionTarget } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "phase-b3-mock-write",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status: "pending",
    reason: "外部SaaSへの投稿には承認が必要です",
    payload: {},
    requestedAt: "2026-09-06T00:00:00.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const target: BotActionTarget = {
  channel: "slack",
  conversation: { externalConversationId: "C1", type: "channel" },
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 基本形: approvalIdとreasonがそのまま渡る ----
  {
    const action = toBotRequestApprovalAction(makeApproval(), target, "msg-1");

    results.push(
      check(
        "[基本] kind=request_approval、approvalId/targetが正しく設定される",
        action.kind === "request_approval" &&
          action.approvalId === "approval-1" &&
          action.target === target &&
          action.inReplyToMessageId === "msg-1"
      )
    );

    results.push(
      check(
        "[Phase C2.1c-b] workIdがApproval.workIdからそのまま転記される(decision受信側がgetApproval(workId,...)を再利用できるようにするため)",
        action.workId === "work-1"
      )
    );

    results.push(
      check(
        "[基本] payload.actionが無い場合、summaryはreasonへフォールバックする",
        action.summary === "外部SaaSへの投稿には承認が必要です"
      )
    );

    results.push(
      check(
        "[基本] optionsはapprove/rejectの2択",
        JSON.stringify(action.options) === JSON.stringify(["approve", "reject"])
      )
    );
  }

  // ---- payload.action.summaryがある場合はそちらを優先する ----
  {
    const approval = makeApproval({
      payload: { scope: "task", action: { kind: "external_write_test", summary: "Slackの#generalへ投稿する" } },
    });

    const action = toBotRequestApprovalAction(approval, target);

    results.push(
      check(
        "[action.summary優先] payload.action.summaryがあればreasonより優先される",
        action.summary === "Slackの#generalへ投稿する"
      )
    );
  }

  // ---- payloadが不正な形でも例外を投げず安全にフォールバックする ----
  {
    const approval = makeApproval({ payload: { action: "not-an-object" } });

    let threw = false;
    let action;

    try {
      action = toBotRequestApprovalAction(approval, target);
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[防御的] payload.actionが想定外の形でも例外を投げず、reasonへ安全にフォールバックする",
        threw === false && action?.summary === approval.reason
      )
    );
  }

  // ---- Provider固有情報が一切含まれないことの確認(絶対条件) ----
  {
    const action = toBotRequestApprovalAction(makeApproval(), target);
    const serialized = JSON.stringify(action);

    results.push(
      check(
        "[Provider非依存] BotRequestApprovalActionにProvider固有のfield名が含まれない",
        !serialized.includes("slackChannelId") &&
          !serialized.includes("gmailMessageId") &&
          !serialized.includes("pipedreamWorkflowId")
      )
    );
  }

  return summarize("bot/approval", results);

}
