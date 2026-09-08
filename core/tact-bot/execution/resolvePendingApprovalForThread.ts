// =========================
// TACT Bot — Pending Approval Thread Resolution (S1e)
// =========================
//
// core/tact-bot/execution/trustedConversationTurn.ts・
// trustedApprovalDecision.tsと同じ「Trusted Bot Execution Boundary」
// パターン: service role keyの読み出しをこのファイルだけに閉じ込め、
// 呼び出し元(core/tact-bot/adapters/slack/productionBotCore.ts)は
// 生のcredential文字列を一切扱わない。
//
// 目的(絶対条件、S1e Step4/5): 外部Channelのthread(channel +
// externalConversationId + externalThreadId)から、
//
//   thread → (既存tact_bot_conversation_links) → TACT Conversation
//   → Conversation.workId → (既存Work) → pending Approval
//
// を解決する。Approval IDをユーザー入力から一切受け取らない
// (絶対条件6)——この関数はthread相関だけからApprovalを特定する。
//
// 絶対条件(fail closed、Step4/5): 各段階で解決できない場合は
// 新しいWork/Conversationを作らず、単に解決失敗として返す
// (呼び出し元が安全な固定文言でユーザーへ案内する)。pending
// Approvalが2件以上ある場合も「最新の1件を勝手に選ぶ」ことをせず、
// ambiguousとして安全側に倒す(Step5絶対条件)。
//
// このfile自身はSlack固有の語彙(BotIncomingMessage・app_mention等)を
// 一切知らない——channel/externalConversationId/externalThreadId/
// tactUserIdという、BOT-P2で確立済みのchannel非依存の語彙だけを
// 受け取る(将来Teams/LINE等の他channelでもそのまま再利用できる、
// findConversationLink()自体が既にchannel非依存の設計であるのと
// 同じ理由)。

import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../database/supabaseServiceRole";
import {
  findConversationLink as defaultFindConversationLink,
  type FindConversationLinkParams,
} from "../conversationLink/supabaseConversationLinkStore";
import type { LinkableBotChannel } from "../identity/supabaseIdentityStore";
import { getConversation as defaultGetConversation } from "../../tact-conversation";
import { listApprovalsForWork as defaultListApprovalsForWork } from "../../tact-work/store";
import type { Approval } from "../../tact-work/types";

export interface ResolvePendingApprovalForThreadParams {

  // server-side identity resolver(core/tact-bot/identity/)が既に
  // 検証済みのtactUserId。外部Channel user idをそのまま使わない
  // (BOT-P2.5の既存絶対条件をそのまま継承、呼び出し元が解決済みの
  // 値を渡す)。
  tactUserId: string;

  channel: LinkableBotChannel;

  externalConversationId: string;

  externalThreadId?: string;

}

export type ResolvePendingApprovalForThreadResult =
  | { status: "resolved"; workId: string; approval: Approval }
  | { status: "trusted_execution_not_configured" }
  | { status: "conversation_link_missing" }
  | { status: "work_missing" }
  | { status: "no_pending_approval" }
  | { status: "ambiguous_pending_approval"; count: number };

export interface ResolvePendingApprovalForThreadDeps {

  getServiceRoleKey: typeof defaultGetServiceRoleKey;

  findConversationLink: (params: FindConversationLinkParams) => Promise<string | null>;

  getConversation: typeof defaultGetConversation;

  listApprovalsForWork: typeof defaultListApprovalsForWork;

}

const defaultDeps: ResolvePendingApprovalForThreadDeps = {
  getServiceRoleKey: defaultGetServiceRoleKey,
  findConversationLink: defaultFindConversationLink,
  getConversation: defaultGetConversation,
  listApprovalsForWork: defaultListApprovalsForWork,
};

export async function resolvePendingApprovalForThread(
  params: ResolvePendingApprovalForThreadParams,
  deps: ResolvePendingApprovalForThreadDeps = defaultDeps
): Promise<ResolvePendingApprovalForThreadResult> {

  const trustedExecutionCredential = deps.getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { status: "trusted_execution_not_configured" };
  }

  // thread → TACT Conversation(既存BOT-P2 link table、channel非依存)。
  const tactConversationId = await deps.findConversationLink({
    channel: params.channel,
    externalConversationId: params.externalConversationId,
    externalThreadId: params.externalThreadId,
  });

  if (!tactConversationId) {
    return { status: "conversation_link_missing" };
  }

  // Conversation → Work。ownership確認はgetConversation()自体が
  // tactUserId(このBoundaryが受け取った、server側で検証済みの値)で
  // 行う——他userのConversationへは到達しない(既存getConversation()の
  // ownership defenseをそのまま利用、新しい検証を増やさない)。
  const conversation = await deps.getConversation(
    tactConversationId,
    params.tactUserId,
    trustedExecutionCredential
  );

  if (!conversation || !conversation.workId) {
    return { status: "work_missing" };
  }

  // Work → pending Approval一覧(既存listApprovalsForWork()、新しい
  // DB queryを追加しない)。
  const approvals = await deps.listApprovalsForWork(
    conversation.workId,
    params.tactUserId,
    trustedExecutionCredential
  );

  const pending = approvals.filter((approval) => approval.status === "pending");

  if (pending.length === 0) {
    return { status: "no_pending_approval" };
  }

  // 絶対条件(Step5、最重要): 「最新の1件を勝手に選ぶ」は禁止。
  // 複数pendingは常にambiguousとして安全側に倒す。
  if (pending.length > 1) {
    return { status: "ambiguous_pending_approval", count: pending.length };
  }

  return { status: "resolved", workId: conversation.workId, approval: pending[0] };

}
