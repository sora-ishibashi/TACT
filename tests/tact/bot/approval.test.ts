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

// APPROVAL-P2: Execution Previewを構築できる、実際のprotected write
// (gmail.send_message)と同じ形のpayloadを持つfixture。
function makeGmailApproval(overrides: Partial<Approval> = {}): Approval {
  return makeApproval({
    payload: {
      scope: "task",
      action: {
        kind: "external_message",
        summary: "メール返信を送信",
        metadata: {
          service: "gmail",
          operation: "send_message",
          input: { to: ["tanaka@example.com"], subject: "Re: 更新案件について", bodyText: "本文" },
          connectionId: "conn-1",
        },
      },
    },
    ...overrides,
  });
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
        "[APPROVAL-P2] previewを構築できないAction(payload.actionが無い等)はoptionsが空になる(fail closed、承認ボタンを出さない判断の根拠)",
        JSON.stringify(action.options) === JSON.stringify([])
      )
    );
  }

  // ---- APPROVAL-P2: previewを構築できる実際のprotected write(gmail.
  // send_message)は、これまで通りoptionsがapprove/rejectの2択になる ----
  {
    const action = toBotRequestApprovalAction(makeGmailApproval(), target);

    results.push(
      check(
        "[APPROVAL-P2] previewを構築できるActionはoptionsがapprove/rejectの2択のまま",
        JSON.stringify(action.options) === JSON.stringify(["approve", "reject"])
      )
    );

    results.push(
      check(
        "[APPROVAL-P2] previewが構築され、frozen actionの値(送信先/件名/本文)がそのまま含まれる",
        action.preview !== undefined &&
          action.preview.fields.some((f) => f.value === "tanaka@example.com") &&
          action.preview.fields.some((f) => f.value === "Re: 更新案件について") &&
          action.preview.fields.some((f) => f.value === "本文")
      )
    );

    results.push(
      check(
        "[APPROVAL-P2] previewのconnectionIdは一切含まれない",
        !JSON.stringify(action.preview).includes("conn-1")
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
