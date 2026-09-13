import type { ExecutionPreview, ExecutionPreviewBuilder } from "./executionPreview";

// =========================
// TACT Work — Slack Send Execution Preview Builder (APPROVAL-P2)
// =========================
//
// 絶対条件(このphaseの明示的判断): APPROVAL-P2はGmail専用ではなく
// generic cross-provider基盤である(ROLE参照)。core/tact-integration/
// policy.tsのPOLICY_ALLOWLISTには既にslack.send_message(riskClass:
// "write")が登録されており、core/tact-orchestrator/decomposer.ts
// 経由で実際に到達しうる既存のprotected write action。このbuilderを
// 追加しない場合、既存のslack.send_message Approvalが「preview
// builder未登録」としてfail closed(承認ボタン非表示)になり、
// BACKWARD COMPATIBILITY絶対条件(既存Approval実行semanticsを変更
// しない)に反する——そのためNEW SCOPEの拡張ではなく、既存protected
// write pathを壊さないために必須の対応として実装する。
//
// 絶対条件(SIDE-EFFECT FREE PREVIEW): Slack APIを一切呼ばない。
export const buildSlackSendPreview: ExecutionPreviewBuilder = (action) => {

  const input = action.input;

  const channel = input.channel;
  const text = input.text;

  if (typeof channel !== "string" || !channel.trim() || typeof text !== "string") {
    return undefined;
  }

  const preview: ExecutionPreview = {

    version: 1,

    actionLabel: "メッセージを1件送信",

    service: action.service,

    operation: action.operation,

    target: { label: channel },

    summary: `Slackの「${channel}」へメッセージを送信します。`,

    fields: [
      { label: "送信先チャンネル", value: channel },
      { label: "本文", value: text },
    ],

    effects: {
      externalCommunication: true,
      externalWrite: true,
      notification: true,
      destructive: false,
      irreversible: true,
    },

    warnings: ["送信後の取り消しはTACTからはできません。"],

  };

  return preview;

};
