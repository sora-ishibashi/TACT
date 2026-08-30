// =========================
// TACT Bot — buildBotContext (BOT-P1)
// =========================
//
// BotIncomingMessage + 解決済みidentityから、Core/Orchestratorへ渡す
// 直前の正規化済みBotContextを組み立てる、pureに近い関数。
//
// 重要: ここでは意図解釈・タスク分解・Product選択を一切行わない
// (絶対条件、core/tact-bot/types.ts冒頭コメント参照)。行うのは
// 「@メンション等、Bot呼び出しのための定型文字列を取り除く」という
// 最小限の文字列正規化のみであり、これは既存Provider(Slack等)側の
// protocol上の定型パターンを剥がすだけの決定論的な処理である。

import type { BotContext, BotIdentity, BotIncomingMessage } from "../types";

// "@TACT " "@tact:" 等、文頭のmention的な定型文字列を取り除く。
// Slack実装(BOT-P2)ではplatform側が返す実際のmention記法
// (例: "<@U0123ABCD> ")をChannelAdapter.normalizeIncoming()側で
// 既に剥がした上でtextへ渡す想定のため、ここでの正規化は
// 「@tact」のようなplainな残存文字列に対する保険的な最小処理に留める
// (新しいNLP/意図解釈は追加しない)。
const LEADING_MENTION_PATTERN = /^\s*@?tact\s*[:,]?\s*/i;

export function buildBotContext(
  message: BotIncomingMessage,
  identity: BotIdentity | null
): BotContext {

  const normalizedInput = message.text.replace(LEADING_MENTION_PATTERN, "").trim();

  return {
    message,
    identity,
    normalizedInput,
  };

}
