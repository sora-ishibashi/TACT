import { Conversation, ConversationMessage } from "./types";

// =========================
// Clarification Persistence (Phase 55)
// =========================
//
// Phase52 Product Decision(Clarification=B: Conversation Stateとして
// DB永続化する)を、Phase53/54で設計した通りに実装する。
//
// 責務(Phase54 Decision通り、core/conversation/index.tsの既存の
// ファイル分割方針——mergeWriterOutput.ts・collectPastEvidence.ts・
// reconstructTask.ts等、責務ごとに独立ファイルへ切り出す——を踏襲):
//   - 元入力・Clarification質問文・ユーザー回答そのものは、
//     Conversation.messagesから導出する(Derived、専用フィールドへ
//     複製しない、Phase54 Decision A)。
//   - 真に新しい状態は「pendingであること」だけ
//     (Conversation.pendingClarificationMessageId/AnsweredAt)。
//   - DBアクセスはこのファイルでは一切行わない(既存の責務分離、
//     呼び出し元がsaveConversation()で永続化する)。
//
// 重要(絶対条件): detectAmbiguity()(core/tact-orchestrator/
// ambiguityDetector.ts)をConversation Layerへ移していない。
// このファイルは「pendingの記録・検出・結合」だけを行い、
// 「曖昧かどうかの判定」自体は一切持たない。

export interface PendingClarification {

  // Clarification質問の本文(Conversation.messagesから取得済み)。
  question: string;

  // 質問の直前にあったユーザーの元入力(Conversation.messagesから
  // 取得済み。見つからない場合は空文字——推測で埋めない)。
  originalInput: string;

  // 質問メッセージ自体のid(pendingClarificationMessageIdと同じ値)。
  questionMessageId: string;

  // Phase54 Decision E: pending(false)かanswered(true)かを表す。
  // "executed"は独立状態として持たない(Execution成功時にpending自体が
  // クリアされるため)。
  answered: boolean;

}

// 現在pendingなClarificationがあるかどうかを、Conversation State
// (messages + pendingClarificationMessageId/AnsweredAt)から判定する。
// pendingClarificationMessageIdが指すmessageが実際には見つからない
// 場合(データ不整合)は、安全側としてpendingなしとして扱う
// (推測で復元しない)。
export function getPendingClarification(
  conversation: Conversation
): PendingClarification | null {

  if (!conversation.pendingClarificationMessageId) {
    return null;
  }

  const questionIndex = conversation.messages.findIndex(
    (message) => message.id === conversation.pendingClarificationMessageId
  );

  if (questionIndex === -1) {
    return null;
  }

  const questionMessage = conversation.messages[questionIndex];
  const originalInputMessage = conversation.messages[questionIndex - 1];

  return {

    question: questionMessage.content,

    originalInput: originalInputMessage?.content ?? "",

    questionMessageId: questionMessage.id,

    answered: !!conversation.pendingClarificationAnsweredAt,

  };

}

// Clarification質問が発生した際、Conversationへ記録する
// (in-memoryの変更のみ、呼び出し元がsaveConversation()で永続化する)。
export function recordClarificationQuestion(
  conversation: Conversation,
  question: string
): ConversationMessage {

  const message: ConversationMessage = {

    id: crypto.randomUUID(),

    role: "assistant",

    content: question,

    createdAt: new Date().toISOString(),

    messageType: "clarification_question",

  };

  conversation.messages.push(message);

  conversation.pendingClarificationMessageId = message.id;

  conversation.pendingClarificationAnsweredAt = undefined;

  conversation.updatedAt = message.createdAt;

  return message;

}

// ユーザーがClarificationへ回答した時点の記録。回答自体は通常の
// user messageとして保存する(Phase54 Decision A: markerを付けない、
// 通常のユーザー発言と区別しない)。
export function recordClarificationAnswer(
  conversation: Conversation,
  answer: string
): ConversationMessage {

  const message: ConversationMessage = {

    id: crypto.randomUUID(),

    role: "user",

    content: answer,

    createdAt: new Date().toISOString(),

  };

  conversation.messages.push(message);

  conversation.pendingClarificationAnsweredAt = message.createdAt;

  conversation.updatedAt = message.createdAt;

  return message;

}

// Execution成功時にpending状態をクリアする("answered" → "cleared"、
// Phase54 Decision E: "executed"という状態は独立して永続化しない)。
export function clearPendingClarification(
  conversation: Conversation
): void {

  conversation.pendingClarificationMessageId = undefined;

  conversation.pendingClarificationAnsweredAt = undefined;

}

// Phase54 Decision D: 元入力＋Clarification質問＋回答を、1つの
// 実行用input文字列へ結合する。結合処理はConversation Layerの責務
// (Execution Layerは結合済みinputを通常のinputとして受け取るだけ)。
//
// components/orchestrateClarification.tsの同名関数(Phase46)と
// 同じ結合形式を採用する。正本はこちらへ移し(Phase54 Decision Dの
// 実装)、components側は後方互換のための再エクスポートとする
// (ResearchPanel.tsx等の既存呼び出し元は変更しない)。
export function buildClarificationResendInput(
  originalInput: string,
  question: string,
  answer: string
): string {

  return `${originalInput}\n(補足: 「${question}」への回答: ${answer})`;

}
