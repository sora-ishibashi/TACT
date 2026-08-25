// =========================
// Clarification Persistence Regression (Phase 55)
// =========================
//
// 対象: core/conversation/clarification.ts(pending検出・記録・結合、
// 全て純粋関数・DBアクセスなし)、core/conversation/store.tsの
// row↔domain変換(toConversation()/toConversationMessage()、Phase55で
// message_type/pendingClarification*フィールドを追加)。
//
// 絶対条件: このファイル自体は実Supabase接続を行わない(LLM/Search API
// 呼び出しも0件)。実DBを使った後方互換性・FK順序の検証は、別途
// 一時スクリプトで実施しレポートに記載する(Phase37以来の既存方針:
// 調査用の実DBアクセスはtests/tact/の決定論的Harnessには含めない)。

import {
  getPendingClarification,
  recordClarificationQuestion,
  recordClarificationAnswer,
  clearPendingClarification,
  buildClarificationResendInput,
} from "../../../core/conversation/clarification";
import {
  toConversation,
  toConversationMessage,
  type ConversationRow,
  type ConversationMessageRow,
} from "../../../core/conversation/store";
import type { Conversation } from "../../../core/conversation/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = new Date().toISOString();
  return {
    id: "conv-1",
    userId: "user-1",
    title: "test",
    createdAt: now,
    updatedAt: now,
    currentTask: "",
    currentOutput: null,
    messages: [],
    workflowRuns: [],
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test 1: pendingなしの通常ConversationはgetPendingClarification()がnull ----
  {
    const conversation = makeConversation();
    results.push(
      check(
        "[Test1] pendingClarificationMessageId未設定 -> getPendingClarification()はnull",
        getPendingClarification(conversation) === null
      )
    );
  }

  // ---- Test 2: recordClarificationQuestion() -> pending状態が正しく設定される ----
  {
    const conversation = makeConversation({
      messages: [
        { id: "m1", role: "user", content: "調べて", createdAt: new Date().toISOString() },
      ],
    });

    const questionMessage = recordClarificationQuestion(conversation, "何について調べればいいですか?");

    results.push(
      check(
        "[Test2] recordClarificationQuestion()がmessageType='clarification_question'のassistant messageを追加する",
        questionMessage.role === "assistant" &&
          questionMessage.messageType === "clarification_question" &&
          questionMessage.content === "何について調べればいいですか?"
      )
    );

    results.push(
      check(
        "[Test2] pendingClarificationMessageIdが新規messageのidに設定される",
        conversation.pendingClarificationMessageId === questionMessage.id
      )
    );

    results.push(
      check(
        "[Test2] pendingClarificationAnsweredAtは未設定のまま(pending)",
        conversation.pendingClarificationAnsweredAt === undefined
      )
    );

    // ---- Test 3: getPendingClarification()が元入力・質問文をmessagesから導出する ----
    const pending = getPendingClarification(conversation);

    results.push(
      check(
        "[Test3] getPendingClarification()が質問文・元入力をmessagesから正しく導出する(Derived、複製なし)",
        pending?.question === "何について調べればいいですか?" &&
          pending?.originalInput === "調べて" &&
          pending?.answered === false,
        `pending=${JSON.stringify(pending)}`
      )
    );

    // ---- Test 4: recordClarificationAnswer() -> answered状態へ遷移 ----
    const answerMessage = recordClarificationAnswer(conversation, "トヨタの競合について");

    results.push(
      check(
        "[Test4] recordClarificationAnswer()がmessageTypeを持たない通常のuser messageを追加する",
        answerMessage.role === "user" && answerMessage.messageType === undefined
      )
    );

    results.push(
      check(
        "[Test4] pendingClarificationAnsweredAtが設定される(pending -> answered)",
        typeof conversation.pendingClarificationAnsweredAt === "string"
      )
    );

    results.push(
      check(
        "[Test4] pendingClarificationMessageIdはanswered中も維持される(クリアされない)",
        conversation.pendingClarificationMessageId === questionMessage.id
      )
    );

    const pendingAfterAnswer = getPendingClarification(conversation);

    results.push(
      check(
        "[Test4] getPendingClarification().answered === true",
        pendingAfterAnswer?.answered === true
      )
    );

    // ---- Test 5: Execution失敗時、pending/answered状態を維持する(Decision F) ----
    // (Execution失敗はconversation_workflow_runsへの追加のみで表現され、
    //  pendingClarification*フィールドは一切変更しない——このテストでは
    //  「何もしないこと」自体を確認する)
    const beforeFailureMessageId = conversation.pendingClarificationMessageId;
    const beforeFailureAnsweredAt = conversation.pendingClarificationAnsweredAt;
    // (Execution失敗時に呼ばれるべき関数は存在しない、Decision F通り
    //  意図的に何も呼ばない)

    results.push(
      check(
        "[Test5] Execution失敗を模擬(何もしない)してもpending/answered状態が変化しない",
        conversation.pendingClarificationMessageId === beforeFailureMessageId &&
          conversation.pendingClarificationAnsweredAt === beforeFailureAnsweredAt
      )
    );

    // ---- Test 6: clearPendingClarification() -> Execution成功時にcleared ----
    clearPendingClarification(conversation);

    results.push(
      check(
        "[Test6] clearPendingClarification()で両フィールドがundefinedへ戻る(cleared)",
        conversation.pendingClarificationMessageId === undefined &&
          conversation.pendingClarificationAnsweredAt === undefined
      )
    );

    results.push(
      check(
        "[Test6] clear後はgetPendingClarification()がnullを返す",
        getPendingClarification(conversation) === null
      )
    );

  }

  // ---- Test 7: buildClarificationResendInput()がPhase46と同じ結合形式を維持する(回帰) ----
  {
    const combined = buildClarificationResendInput("調べて", "何について調べればいいですか?", "トヨタの競合について");

    results.push(
      check(
        "[Test7] buildClarificationResendInput()の結合形式がPhase46から変化していない",
        combined === "調べて\n(補足: 「何について調べればいいですか?」への回答: トヨタの競合について)",
        `combined=${JSON.stringify(combined)}`
      )
    );
  }

  // ---- Test 8: 参照先messageが見つからない場合、安全側でnullを返す(データ不整合の防御) ----
  {
    const conversation = makeConversation({
      pendingClarificationMessageId: "nonexistent-id",
      messages: [{ id: "m1", role: "user", content: "hello", createdAt: new Date().toISOString() }],
    });

    results.push(
      check(
        "[Test8] pendingClarificationMessageIdが指すmessageが存在しない場合、推測せずnullを返す",
        getPendingClarification(conversation) === null
      )
    );
  }

  // ---- Test 9: store.ts row↔domain変換(実DB接続なし、純粋なデータ変換の検証) ----
  {
    const messageRow: ConversationMessageRow = {
      id: "m1",
      conversation_id: "conv-1",
      role: "assistant",
      content: "何について調べればいいですか?",
      created_at: "2026-08-24T00:00:00.000Z",
      message_type: "clarification_question",
    };

    const message = toConversationMessage(messageRow);

    results.push(
      check(
        "[Test9] toConversationMessage(): message_type='clarification_question'が正しくmessageTypeへ変換される",
        message.messageType === "clarification_question"
      )
    );

    const normalMessageRow: ConversationMessageRow = {
      id: "m2",
      conversation_id: "conv-1",
      role: "user",
      content: "hello",
      created_at: "2026-08-24T00:00:00.000Z",
      message_type: null,
    };

    const normalMessage = toConversationMessage(normalMessageRow);

    results.push(
      check(
        "[Test9] toConversationMessage(): message_type=null(既存データ) -> messageTypeはundefined(後方互換)",
        normalMessage.messageType === undefined
      )
    );

    const conversationRowWithPending: ConversationRow = {
      id: "conv-1",
      user_id: "user-1",
      title: null,
      current_task: "",
      current_output: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
      pending_clarification_message_id: "m1",
      pending_clarification_answered_at: null,
    };

    const conversationWithPending = toConversation(conversationRowWithPending, [message], []);

    results.push(
      check(
        "[Test9] toConversation(): pending_clarification_message_idが正しくpendingClarificationMessageIdへ変換される",
        conversationWithPending.pendingClarificationMessageId === "m1" &&
          conversationWithPending.pendingClarificationAnsweredAt === undefined
      )
    );

    const conversationRowExisting: ConversationRow = {
      id: "conv-old",
      user_id: null,
      title: null,
      current_task: "既存の会話",
      current_output: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      pending_clarification_message_id: null,
      pending_clarification_answered_at: null,
    };

    const existingConversation = toConversation(conversationRowExisting, [normalMessage], []);

    results.push(
      check(
        "[Test9-後方互換] Phase55以前の既存Conversation行(pending_clarification_*が両方NULL)も正しく変換される",
        existingConversation.pendingClarificationMessageId === undefined &&
          existingConversation.pendingClarificationAnsweredAt === undefined &&
          existingConversation.currentTask === "既存の会話"
      )
    );

  }

  return summarize("clarification persistence (Phase 55)", results);

}
