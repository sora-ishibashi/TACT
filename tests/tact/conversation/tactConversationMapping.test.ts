// =========================
// TACT Conversation — DB row ↔ domain mapping Regression (Phase 65)
// =========================
//
// 対象: core/tact-conversation/store.tsのtoConversation()/
// toConversationSummary()/toConversationMessage()/toExecutionRecord()
// (いずれも純粋関数、DBアクセスなし)。
//
// 絶対条件(Phase55の既存方針をそのまま踏襲): このファイル自体は実
// Supabase接続を行わない(LLM/Search API呼び出しも0件)。Stage1 RLS・
// Write Ordering・FK制約を含めた実DB上でのふるまいの検証は、別途
// 一時スクリプトで実施しレポートに記載する(tests/tact/の決定論的
// Harnessには含めない)。

import {
  toConversation,
  toConversationSummary,
  toConversationMessage,
  toExecutionRecord,
  type ConversationRow,
  type ConversationMessageRow,
  type ExecutionRecordRow,
} from "../../../core/tact-conversation/store";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test 1: toConversation() — pendingなし ----
  {
    const row: ConversationRow = {
      id: "conv-1",
      user_id: "user-1",
      title: "test",
      project_id: null,
      artifact_id: null,
      work_id: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
      pending_clarification_message_id: null,
      pending_clarification_answered_at: null,
    };

    const conversation = toConversation(row);

    results.push(
      check(
        "[Test1] toConversation(): 基本フィールドがsnake_case -> camelCaseへ変換される",
        conversation.id === "conv-1" &&
          conversation.userId === "user-1" &&
          conversation.title === "test"
      )
    );

    results.push(
      check(
        "[Test1] toConversation(): project_id=null(未所属Conversation) -> projectIdもnull",
        conversation.projectId === null
      )
    );

    results.push(
      check(
        "[Test1] toConversation(): pending_clarification_*がnullの場合、そのままnullとして保持される",
        conversation.pendingClarificationMessageId === null &&
          conversation.pendingClarificationAnsweredAt === null
      )
    );
  }

  // ---- Test 2: toConversation() — pendingあり(質問中) ----
  {
    const row: ConversationRow = {
      id: "conv-2",
      user_id: "user-1",
      title: null,
      project_id: "proj-1",
      artifact_id: "art-1",
      work_id: "work-1",
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:01:00.000Z",
      pending_clarification_message_id: "msg-q1",
      pending_clarification_answered_at: null,
    };

    const conversation = toConversation(row);

    results.push(
      check(
        "[Test2] toConversation(): pending_clarification_message_idのみ設定(質問中、未回答)",
        conversation.pendingClarificationMessageId === "msg-q1" &&
          conversation.pendingClarificationAnsweredAt === null
      )
    );

    results.push(
      check(
        "[Test2] toConversation(): project_id='proj-1'(Folder所属) -> projectIdへ正しく変換される",
        conversation.projectId === "proj-1"
      )
    );

    results.push(
      check(
        "[Test2] toConversation(): artifact_id='art-1'(Phase75) -> artifactIdへ正しく変換される",
        conversation.artifactId === "art-1"
      )
    );

    results.push(
      check(
        "[Test2] toConversation(): work_id='work-1'(Phase B2) -> workIdへ正しく変換される",
        conversation.workId === "work-1"
      )
    );
  }

  // ---- Test 3: toConversationSummary() — 一覧表示用の軽量変換 ----
  {
    const row: ConversationRow = {
      id: "conv-3",
      user_id: "user-1",
      title: "会話タイトル",
      project_id: "proj-2",
      artifact_id: null,
      work_id: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:02:00.000Z",
      pending_clarification_message_id: "msg-q2",
      pending_clarification_answered_at: "2026-08-24T00:03:00.000Z",
    };

    const summary = toConversationSummary(row);

    results.push(
      check(
        "[Test3] toConversationSummary(): id/title/projectId/created_at/updated_atを持ち、pending系フィールドを含まない",
        summary.id === "conv-3" &&
          summary.title === "会話タイトル" &&
          summary.projectId === "proj-2" &&
          summary.createdAt === row.created_at &&
          summary.updatedAt === row.updated_at &&
          !("pendingClarificationMessageId" in summary)
      )
    );
  }

  // ---- Test 4: toConversationMessage() — 通常メッセージ(message_type=null) ----
  {
    const row: ConversationMessageRow = {
      id: "msg-1",
      conversation_id: "conv-1",
      role: "user",
      content: "トヨタの競合について調べて",
      message_type: null,
      execution_record_id: null,
      created_at: "2026-08-24T00:00:00.000Z",
    };

    const message = toConversationMessage(row);

    results.push(
      check(
        "[Test4] toConversationMessage(): message_type=null -> messageTypeはnull(通常メッセージ)",
        message.role === "user" &&
          message.content === "トヨタの競合について調べて" &&
          message.messageType === null &&
          message.executionRecordId === null
      )
    );
  }

  // ---- Test 5: toConversationMessage() — Clarification質問メッセージ ----
  {
    const row: ConversationMessageRow = {
      id: "msg-q1",
      conversation_id: "conv-2",
      role: "assistant",
      content: "何について調べればいいですか?",
      message_type: "clarification_question",
      execution_record_id: null,
      created_at: "2026-08-24T00:00:00.000Z",
    };

    const message = toConversationMessage(row);

    results.push(
      check(
        "[Test5] toConversationMessage(): message_type='clarification_question'が正しく変換される",
        message.role === "assistant" && message.messageType === "clarification_question"
      )
    );
  }

  // ---- Test 6: toConversationMessage() — Execution結果に紐づくassistantメッセージ ----
  {
    const row: ConversationMessageRow = {
      id: "msg-2",
      conversation_id: "conv-1",
      role: "assistant",
      content: "調査結果はこちらです",
      message_type: null,
      execution_record_id: "exec-1",
      created_at: "2026-08-24T00:05:00.000Z",
    };

    const message = toConversationMessage(row);

    results.push(
      check(
        "[Test6] toConversationMessage(): execution_record_idが正しくexecutionRecordIdへ変換される",
        message.executionRecordId === "exec-1"
      )
    );
  }

  // ---- Test 7: toExecutionRecord() — completed ----
  {
    const row: ExecutionRecordRow = {
      id: "exec-1",
      conversation_id: "conv-1",
      capability: "research",
      input: "トヨタの競合について調べて",
      status: "completed",
      created_at: "2026-08-24T00:05:00.000Z",
    };

    const record = toExecutionRecord(row);

    results.push(
      check(
        "[Test7] toExecutionRecord(): capability/status/inputが正しく変換される",
        record.capability === "research" &&
          record.status === "completed" &&
          record.input === "トヨタの競合について調べて" &&
          record.conversationId === "conv-1"
      )
    );
  }

  // ---- Test 8: toExecutionRecord() — failed/partial/orchestratorも変換できる ----
  {
    const rowFailed: ExecutionRecordRow = {
      id: "exec-2",
      conversation_id: "conv-1",
      capability: "orchestrator",
      input: "PowerPointで資料を作って",
      status: "failed",
      created_at: "2026-08-24T00:06:00.000Z",
    };

    const recordFailed = toExecutionRecord(rowFailed);

    results.push(
      check(
        "[Test8] toExecutionRecord(): capability='orchestrator' / status='failed'も正しく変換される",
        recordFailed.capability === "orchestrator" && recordFailed.status === "failed"
      )
    );

    const rowPartial: ExecutionRecordRow = {
      id: "exec-3",
      conversation_id: "conv-1",
      capability: "core_push",
      input: "この情報をCoreに保存して",
      status: "partial",
      created_at: "2026-08-24T00:07:00.000Z",
    };

    const recordPartial = toExecutionRecord(rowPartial);

    results.push(
      check(
        "[Test8] toExecutionRecord(): capability='core_push' / status='partial'も正しく変換される",
        recordPartial.capability === "core_push" && recordPartial.status === "partial"
      )
    );
  }

  return summarize("tact-conversation mapping (Phase 65)", results);

}
