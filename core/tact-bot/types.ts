// =========================
// TACT Bot — Public Types (BOT-P1)
// =========================
//
// TACT Botは、Slack/LINE等ユーザーが普段使っているチャット環境から
// TACT Core/Orchestratorへ依頼を橋渡しするChannel Gatewayである。
//
// ここで定義する型はすべてplatform非依存(platform-independent)。
// Slack Block Kit・LINE Flex Message等のplatform固有UI形式は、
// core/tact-bot/配下のどの型にも一切持ち込まない
// (core/tact-bot/adapters/配下の各ChannelAdapter実装、BOT-P2以降が
// platform固有の変換を担う)。
//
// 重要(責務境界、BOT-P1絶対条件): core/tact-bot/配下のどのmoduleも、
// 以下を行わない。
//   - タスク分解 / Workflow設計 / Product選択
//   - Research判断 / Design判断 / Agent orchestration
//   - 業務上の意思決定
// これらは既存のcore/tact-orchestrator(decomposeTask/runOrchestration)
// ・core/tact-research・core/tact-conversation側の責務であり、
// core/tact-bot自身が独自のPlanner/Agent orchestration/LLM reasoningを
// 持つことは禁止する。

// =========================
// Channel / Actor / Conversation (Bot -> Core, 正規化された入力)
// =========================

export type BotChannel = "slack" | "line" | "teams" | "discord" | "unknown";

export interface BotActor {

  // platform側のuser識別子(Slack user ID、LINE userId等)。
  externalUserId: string;

  // identity resolver(core/tact-bot/identity/resolver.ts)が解決できた
  // 場合のみ設定される、TACT側のuserId。BOT-P1時点では永続的な
  // mapping機構が無いため、未解決(undefined)が既定。
  tactUserId?: string;

  displayName?: string;

}

export type BotConversationType = "dm" | "group" | "channel";

export interface BotConversation {

  // platform側のconversation/channel識別子。
  externalConversationId: string;

  type: BotConversationType;

  // Slack thread_ts等、返信先スレッドがある場合のみ設定する。
  threadId?: string;

}

// ChannelAdapter.normalizeIncoming()が、platform固有のwebhook
// payloadから組み立てるplatform非依存のincoming message。
export interface BotIncomingMessage {

  channel: BotChannel;

  actor: BotActor;

  conversation: BotConversation;

  // platform側のteam/workspace識別子(Slack team ID等)。TACT側の
  // Organization概念(core/tact-core側は現時点でUser Scopeのみ実装
  // 済み、Organization Scope未実装)とは別の、外部platform由来の
  // 生の識別子であることに注意。
  organizationId?: string;

  // platform側のmessage識別子(重複受信の検知等に使える)。
  messageId: string;

  text: string;

  // channel/group会話でBotへ話しかけられたか(@メンション等)。
  // DM会話では常にtrueとして扱ってよい(gateway側の既定判断)。
  mentionedTact: boolean;

  // スレッド内返信等、特定messageへの返信である場合のみ設定する。
  replyToMessageId?: string;

  // platform固有の追加情報を必要に応じて保持する開かれた領域
  // (core/tact-core/knowledge/types.tsのKnowledgeItem.metadataと同じ
  // 考え方: 新しい抽象化を増やしすぎず、ここへ閉じ込める)。
  metadata?: Record<string, unknown>;

  receivedAt: string;

}

// =========================
// BotAction (Core -> Bot, 正規化された出力境界)
// =========================
//
// Slack固有・LINE固有のUI形式(Block Kit/Flex Message等)はこの型へ
// 一切含めない。配送先の解決とplatform固有formatへの変換は
// ChannelAdapter.executeAction()(BOT-P2以降で実装)の責務。

export interface BotActionTarget {

  channel: BotChannel;

  conversation: BotConversation;

  // send_dm・request_approvalのように特定個人が宛先になる場合に使う。
  actor?: BotActor;

}

interface BotActionBase {

  target: BotActionTarget;

  // このActionがどのincoming messageへの応答かの追跡用(任意)。
  inReplyToMessageId?: string;

}

// 元の会話(channel/group/DM)へそのまま返信する。
export interface BotReplyAction extends BotActionBase {
  kind: "reply";
  text: string;
}

// 元の会話とは独立して、特定個人へDMを送る
// (例: 将来の承認依頼の下準備として担当者へ直接連絡する等)。
export interface BotSendDmAction extends BotActionBase {
  kind: "send_dm";
  text: string;
}

// 特定個人へ承認を依頼する。実際の承認Workflow(複数人承認・
// 回答の集約等)はBOT-P1のscope外(「今回やらないもの」参照)。
// ここでは「承認を求めるAction自体」をplatform非依存に表現できる
// ことのみを保証する。
export interface BotRequestApprovalAction extends BotActionBase {
  kind: "request_approval";
  approvalId: string;
  summary: string;
  options?: string[];
}

// 実行中の進捗を通知する(例: 「Researchを実行中です」)。
export interface BotNotifyProgressAction extends BotActionBase {
  kind: "notify_progress";
  stage: string;
  message?: string;
}

// 最終成果物を配送する。Artifactそのもの(core/tact-artifact)への
// 参照はartifactIdとしてのみ保持し、Blockの中身はここへ持ち込まない
// (Artifact本体の取得・表示は既存のArtifact取得経路に委ねる)。
export interface BotDeliverResultAction extends BotActionBase {
  kind: "deliver_result";
  summary: string;
  resultText?: string;
  artifactId?: string;
}

export type BotAction =
  | BotReplyAction
  | BotSendDmAction
  | BotRequestApprovalAction
  | BotNotifyProgressAction
  | BotDeliverResultAction;

export type BotActionKind = BotAction["kind"];

// ChannelAdapter.executeAction()の戻り値。platform固有の配送結果
// (message ts等)はrawへ任意に格納してよいが、Core側の型契約には
// 影響させない。
export interface BotActionDeliveryResult {

  ok: boolean;

  actionKind: BotActionKind;

  error?: string;

  raw?: unknown;

}

// =========================
// Identity
// =========================

export interface BotIdentity {

  tactUserId: string;

  organizationId?: string;

}

// =========================
// Bot Context (buildBotContext()の出力。Core/Orchestratorへ渡す
// 直前の、正規化済みcontext)
// =========================

export interface BotContext {

  message: BotIncomingMessage;

  // identity resolverが解決できなかった場合はnull(「未解決」を
  // 安全に表現する。存在しないTACT userへfallbackしない)。
  identity: BotIdentity | null;

  // mention文字列除去等、最小限の正規化を経たテキスト
  // (core/tact-bot/context/buildBotContext.ts参照)。意図解釈・
  // タスク分解はここでは一切行わない。
  normalizedInput: string;

}
