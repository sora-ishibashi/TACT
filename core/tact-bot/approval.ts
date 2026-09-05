import type { Approval } from "../tact-work/types";
import type { BotActionTarget, BotRequestApprovalAction } from "./types";

// =========================
// TACT Bot — Approval Translation Boundary
// (Architecture Migration Phase B3)
// =========================
//
// 目的: Canonical Approval(core/tact-work/types.tsのApproval、
// core/tact-work/approval.tsのrequestApproval()が作る)を、Bot上で
// 提示するためのInterface Action(BotRequestApprovalAction、
// core/tact-bot/types.ts、BOT-P1で既に定義済み)へ変換する、
// 純粋な一方向のtranslation。
//
// 絶対条件(Phase B3): ApprovalというCanonical stateはTACT Core
// (core/tact-work/)側だけが所有する。この関数はApproval状態を
// 複製・保存せず、表示に必要なfield(approvalId/summary/reason)だけを
// 抜き出すだけの薄いAdapterであり、Work Router/Approval判断ロジック
// を一切持たない(BotはApproval Routerではない、既存BOT-P1/BOT-P2.5
// と同じ責務分離)。
//
// DBアクセス・実行判断は一切行わない(pure関数)。approve/reject自体は
// core/tact-work/approval.tsのapproveApproval()/rejectApproval()を
// 呼び出し元(例: 将来のSlack Interactive Component handler)が直接
// 呼ぶ——この関数はそのための「表示用の最小限の情報」を組み立てる
// だけ。

// Approval.payload(jsonb、core/tact-work/approval.tsのApprovalRequest.
// actionから組み立てられる)からaction.summaryだけを安全に取り出す。
// payloadの形は呼び出し元次第で変わりうる(Provider固有ではなく
// Approval Coreの都合で決まる)ため、型を強制せず存在確認だけ行う。
function extractActionSummary(payload: Record<string, unknown>): string | undefined {

  const action = payload.action;

  if (
    action &&
    typeof action === "object" &&
    "summary" in action &&
    typeof (action as { summary: unknown }).summary === "string"
  ) {
    return (action as { summary: string }).summary;
  }

  return undefined;

}

export function toBotRequestApprovalAction(
  approval: Approval,
  target: BotActionTarget,
  inReplyToMessageId?: string
): BotRequestApprovalAction {

  return {

    kind: "request_approval",

    target,

    inReplyToMessageId,

    approvalId: approval.id,

    // action.summary(提案されたaction自体の説明)があればそちらを
    // 優先し、無ければreason(なぜ承認が必要か)を表示する。
    summary: extractActionSummary(approval.payload) ?? approval.reason,

    options: ["approve", "reject"],

  };

}
