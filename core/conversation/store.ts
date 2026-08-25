import { supabase } from "../database/supabase";
import {
  Conversation,
  ConversationMessage,
  ConversationSummary,
  WorkflowRun,
} from "./types";

// =========================
// Conversation Store(Supabase永続化)
// =========================
//
// STEP 5: in-memory Mapによる一時実装を、既存Supabaseプロジェクトの
// 以下3テーブルへの永続化に差し替える。
//
//   conversations              <-> Conversation本体
//   conversation_messages      <-> Conversation.messages
//   conversation_workflow_runs <-> Conversation.workflowRuns
//
// 呼び出し側(app/api/tact/conversation/route.ts)から見た責務は
// 変えない。createConversation()は引き続きcore/conversation/index.ts
// 側の純粋なインメモリファクトリのままとし、DBへの初回保存は
// このファイルのsaveConversation()のupsertが担う
// (新規Conversationの初回Turnも、既存Conversationの継続Turnも、
// 同じ「メモリ上でフル構築 -> 最後にsaveConversation()」という
// 既存の呼び出し順序のまま動作する)。
//
// 制約:
// - currentOutput / outputsはJSONBとしてそのまま保存・復元し、
//   JSON.stringify/parseを手動で行わない。
// - 楽観的ロック(updated_at比較)は、Conversation型が
//   「読み込み時点のupdated_at」を別途保持していないため、
//   既存コード構造を変更せずに安全に実装できない。
//   このため今回(STEP5)では未実装とする。

// =========================
// DB row 型(このファイル内部でのみ使用)
// =========================

// Phase55: exportする理由はtoConversation()/toConversationMessage()と
// 同じ(Testability、STEP20以来の既存パターン)。
export interface ConversationRow {
  id: string;
  user_id: string | null;
  title: string | null;
  current_task: string;
  current_output: unknown;
  created_at: string;
  updated_at: string;
  // Phase55
  pending_clarification_message_id: string | null;
  pending_clarification_answered_at: string | null;
}

export interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  // Phase55
  message_type: "clarification_question" | null;
}

interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  input: string;
  outputs: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

// =========================
// DB row -> ドメイン型 変換
// =========================

// Phase55: exportする理由は既存のcore/tact-orchestrator/executor.tsの
// isTemporaryFailure()等と同じ(Testabilityのための最小変更)。挙動自体は
// 変更していない。row↔domain変換ロジックをEvaluation Harnessから
// 直接検証できるようにする(実Supabase接続を伴わずに、message_type/
// pendingClarification*の往復変換を確認するため)。
export function toConversationMessage(
  row: ConversationMessageRow
): ConversationMessage {

  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    // Phase55: DBのNULLはmessageType未設定(通常メッセージ)を表す。
    messageType: row.message_type ?? undefined,
  };

}

function toWorkflowRun(row: WorkflowRunRow): WorkflowRun {

  return {
    id: row.id,
    input: row.input,
    outputs: row.outputs ?? {},
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };

}

export function toConversation(
  row: ConversationRow,
  messages: ConversationMessage[],
  workflowRuns: WorkflowRun[]
): Conversation {

  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentTask: row.current_task,
    // Writerの出力(unknown)をそのまま保持する。
    // 既存のWriter出力Schemaには一切依存しない。
    currentOutput: row.current_output,
    messages,
    workflowRuns,
    // Phase55
    pendingClarificationMessageId:
      row.pending_clarification_message_id ?? undefined,
    pendingClarificationAnsweredAt:
      row.pending_clarification_answered_at ?? undefined,
  };

}

// =========================
// getConversation
// =========================
//
// conversations / conversation_messages / conversation_workflow_runs
// をそれぞれ取得し、既存のConversation型へ再構成する。
//
// 該当行が存在しない場合は、旧Map実装(conversations.get(id))と
// 同じくundefinedを返す。route.ts側の
// 「存在しなければ新規作成(POST) / 404(GET)」という分岐を
// 変更せずに済ませるための互換仕様。

export async function getConversation(
  id: string
): Promise<Conversation | undefined> {

  const { data: conversationRow, error: conversationError } =
    await supabase
      .from("conversations")
      .select(
        "id, user_id, title, current_task, current_output, created_at, updated_at, pending_clarification_message_id, pending_clarification_answered_at"
      )
      .eq("id", id)
      .maybeSingle();

  if (conversationError) {
    throw conversationError;
  }

  if (!conversationRow) {
    return undefined;
  }

  const { data: messageRows, error: messagesError } =
    await supabase
      .from("conversation_messages")
      .select("id, conversation_id, role, content, created_at, message_type")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });

  if (messagesError) {
    throw messagesError;
  }

  const { data: runRows, error: runsError } =
    await supabase
      .from("conversation_workflow_runs")
      .select(
        "id, conversation_id, input, outputs, status, started_at, completed_at, error"
      )
      .eq("conversation_id", id)
      .order("started_at", { ascending: true });

  if (runsError) {
    throw runsError;
  }

  return toConversation(
    conversationRow as ConversationRow,
    (messageRows ?? []).map((row) =>
      toConversationMessage(row as ConversationMessageRow)
    ),
    (runRows ?? []).map((row) => toWorkflowRun(row as WorkflowRunRow))
  );

}

// =========================
// saveConversation
// =========================
//
// メモリ上に構築されたConversation全体(messages/workflowRunsを含む)を
// Supabaseへ反映する。
//
// - conversations: idを基準にupsert。新規Conversationの初回保存
//   (INSERT相当)も、既存Conversationの更新(UPDATE相当)も、
//   同じ経路で扱える。
// - conversation_messages / conversation_workflow_runs: idを基準に
//   upsert。既に保存済みの行は同一内容で上書き(実質no-op)され、
//   新規の行のみ実質的にINSERTされる。無条件のDELETE->INSERTは
//   行わない。

export async function saveConversation(
  conversation: Conversation
): Promise<void> {

  // Phase55: pending_clarification_message_idは、まだこの時点では
  // 保存されていないかもしれないconversation_messages行を参照しうる
  // (例: 今回のTurnでClarification質問が新規発生した場合、参照先の
  // message行はこの後のmessages upsertで初めて作られる)。そのため
  // conversations本体の保存では、この2フィールドを一旦含めない
  // (INSERT時はデフォルトNULL、UPDATE時は既存値を変更しない
  // ——payloadに含めないキーはPostgRESTのUPSERT ON CONFLICTで
  // 更新対象に含まれないため)。実際の設定/クリアは、
  // conversation_messagesの保存が完了した後の別UPDATEで行う
  // (Phase54で発見したFK順序問題への対応、絶対条件: 新しい
  // transaction機構は導入しない、最小限の順序変更のみ)。

  const { error: conversationError } = await supabase
    .from("conversations")
    .upsert(
      {
        id: conversation.id,
        user_id: conversation.userId ?? null,
        title: conversation.title ?? null,
        current_task: conversation.currentTask,
        current_output: conversation.currentOutput,
        created_at: conversation.createdAt,
        updated_at: conversation.updatedAt,
      },
      { onConflict: "id" }
    );

  if (conversationError) {
    throw conversationError;
  }

  if (conversation.messages.length > 0) {

    const { error: messagesError } = await supabase
      .from("conversation_messages")
      .upsert(
        conversation.messages.map((message) => ({
          id: message.id,
          conversation_id: conversation.id,
          role: message.role,
          content: message.content,
          created_at: message.createdAt,
          // Phase55
          message_type: message.messageType ?? null,
        })),
        { onConflict: "id" }
      );

    if (messagesError) {
      throw messagesError;
    }

  }

  // Phase55: conversation_messagesの保存が完了した今、
  // pending_clarification_message_idが指す行(存在する場合)は
  // 必ず存在するため、安全にconversationsへ反映できる。
  // pendingが無い(undefined)場合はNULLへ明示的にクリアする
  // (Execution成功時の"cleared"遷移も、このUPDATEが担う)。
  const { error: pendingError } = await supabase
    .from("conversations")
    .update({
      pending_clarification_message_id:
        conversation.pendingClarificationMessageId ?? null,
      pending_clarification_answered_at:
        conversation.pendingClarificationAnsweredAt ?? null,
    })
    .eq("id", conversation.id);

  if (pendingError) {
    throw pendingError;
  }

  if (conversation.workflowRuns.length > 0) {

    const { error: runsError } = await supabase
      .from("conversation_workflow_runs")
      .upsert(
        conversation.workflowRuns.map((run) => ({
          id: run.id,
          conversation_id: conversation.id,
          input: run.input,
          outputs: run.outputs,
          status: run.status,
          started_at: run.startedAt,
          completed_at: run.completedAt ?? null,
          error: run.error ?? null,
        })),
        { onConflict: "id" }
      );

    if (runsError) {
      throw runsError;
    }

  }

}

// =========================
// listConversations
// =========================
//
// Conversation一覧を取得する(STEP9)。conversationsテーブルのみを
// 参照し、messages / workflowRunsは取得しない(一覧表示を軽量に
// 保つため)。updated_at降順で並べる。
//
// STEP145-G: サーバー側で認証済みのuserId(core/auth/getUserContext.ts
// 経由、クライアントからの自己申告値は使わない)を受け取り、
// 絞り込みに使う。
// - userIdが確定している場合: そのuserIdのConversationのみ返す。
// - 未認証(userId未指定)の場合: user_id IS NULLのConversationのみ
//   返す(認証導入前に作られた既存データ・未認証フローのデータ)。
//   全ユーザーのConversationを無条件に返していた従来の挙動は
//   他ユーザーの会話が閲覧できてしまう欠陥だったため、ここで修正する。

export async function listConversations(
  limit: number = 30,
  userId?: string | null
): Promise<ConversationSummary[]> {

  let query = supabase
    .from("conversations")
    .select("id, title, current_task, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  query = userId
    ? query.eq("user_id", userId)
    : query.is("user_id", null);

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title ?? undefined,
    currentTask: row.current_task,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

}
