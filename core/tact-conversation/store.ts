import { createClient } from "@supabase/supabase-js";
import {
  Conversation,
  ConversationSummary,
  ConversationMessage,
  ConversationMessageRole,
  ConversationMessageType,
  ExecutionRecord,
  ExecutionCapability,
  ExecutionStatus,
  PendingClarification,
  ConversationMessageAttachment,
} from "./types";

// =========================
// TACT Conversation Store (Phase 65)
// =========================
//
// core/tact-conversation/*の唯一のDBアクセス層。Phase64で作成した
// tact_conversations / tact_conversation_messages / tact_execution_records
// (いずれもStage1 RLS、auth.uid()=user_idベース)を対象とする。
//
// 重要(core/tact-project/store.tsと同じ理由、Phase31で実測確認済みの
// 既存Pattern): core/database/supabase.tsの共有クライアントはanonキー
// のみで生成されており、Supabaseセッションを引き継がない。Stage1 RLS
// (tact_conversations等)は auth.uid() が正しく解決されないと機能
// しないため、検証済みのaccess_tokenをAuthorizationヘッダーとして
// 持つ、リクエストごとのクライアントを構築する(Supabaseの標準的な
// per-request RLSクライアントパターン、core/tact-project/store.tsと
// 完全に同型)。
//
// 絶対条件(RLSをAPIの代わりとして扱わない、core/tact-project/store.ts
// と同じ方針): このRLS前提のクライアントを使う場合でも、各関数は
// 明示的に `.eq(...)` を伴うクエリを組み立てる。RLSは最後の防御層として
// 維持し、所有者判定の主たるロジックはこのファイル(アプリケーション層)
// に置く。tact_conversation_messages / tact_execution_recordsには
// user_id列自体が存在しないため(親conversation_idのみ)、これらへの
// 操作は「呼び出し元が既に所有者検証済みのConversationオブジェクトを
// 保持していること」を前提とする——getConversation()/createConversation()
// 自体がuser_idによる明示的な絞り込みを行うため、以降の子テーブル操作は
// そこで検証済みのconversation.idをそのまま使う。
//
// Phase63/64からの実装上の調整(絶対条件Section5「実装上必要なasync化・
// repository分離・内部helperなどはRepository Evidenceに基づいて調整
// してよい」を適用): 指示書の型契約例ではcreateConversation()等が
// 同期関数だったが、Legacy(core/conversation/index.ts)のような
// 「in-memoryで組み立ててから一括saveConversation()」という設計は、
// tact_conversationsファミリーが正規化された別テーブル(messages配列を
// 埋め込まない、Phase63 Invariant 1)である以上、素直に適用できない。
// 本実装では、Conversation作成・Message追加・ExecutionRecord記録・
// Clarification状態変更はいずれも「呼び出された時点で該当行を直接
// 書き込む」非同期関数として実装する(Legacy Brain-FK回避のような
// 早期save固有の事情が本Architectureには存在しないため、遅延保存の
// 利点がない)。saveConversation()は、Conversationオブジェクト自体の
// 可変フィールド(title等)を明示的に反映するための関数として維持する
// (関数契約自体は指示書通り公開する)。

function createRequestScopedClient(accessToken: string) {

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );

}

// =========================
// DB row 型
// =========================

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  project_id: string | null;
  artifact_id: string | null;
  created_at: string;
  updated_at: string;
  pending_clarification_message_id: string | null;
  pending_clarification_answered_at: string | null;
}

export interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: ConversationMessageRole;
  content: string;
  message_type: ConversationMessageType | null;
  execution_record_id: string | null;
  created_at: string;
}

interface ConversationMessageAttachmentRow {
  message_id: string;
  position: number;
  tact_attachments: {
    id: string;
    original_filename: string;
    mime_type: string;
    file_size_bytes: number;
    extraction_status: ConversationMessageAttachment["extractionStatus"];
  } | null;
}

export interface ExecutionRecordRow {
  id: string;
  conversation_id: string;
  capability: ExecutionCapability;
  input: string;
  status: ExecutionStatus;
  created_at: string;
}

// =========================
// DB row → domain 変換 (snake_case → camelCase)
// =========================

export function toConversation(row: ConversationRow): Conversation {

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    projectId: row.project_id,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pendingClarificationMessageId: row.pending_clarification_message_id,
    pendingClarificationAnsweredAt: row.pending_clarification_answered_at,
  };

}

export function toConversationSummary(row: ConversationRow): ConversationSummary {

  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

export function toConversationMessage(row: ConversationMessageRow): ConversationMessage {

  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    messageType: row.message_type,
    executionRecordId: row.execution_record_id,
    createdAt: row.created_at,
  };

}

export function toExecutionRecord(row: ExecutionRecordRow): ExecutionRecord {

  return {
    id: row.id,
    conversationId: row.conversation_id,
    capability: row.capability,
    input: row.input,
    status: row.status,
    createdAt: row.created_at,
  };

}

const CONVERSATION_COLUMNS =
  "id, user_id, title, project_id, artifact_id, created_at, updated_at, pending_clarification_message_id, pending_clarification_answered_at";

const MESSAGE_COLUMNS =
  "id, conversation_id, role, content, message_type, execution_record_id, created_at";

const EXECUTION_RECORD_COLUMNS =
  "id, conversation_id, capability, input, status, created_at";

// =========================
// createConversation
// =========================
//
// Phase64のtact_conversations.user_idはNOT NULLのため(Phase62/63の
// 判断通り、未認証フローとの互換を持たない)、accessToken/userIdは
// いずれも必須。

export async function createConversation(
  userId: string,
  accessToken: string,
  title?: string,
  projectId?: string | null
): Promise<Conversation> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_conversations")
    .insert({ user_id: userId, title: title ?? null, project_id: projectId ?? null })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toConversation(data as ConversationRow);

}

// =========================
// getConversation
// =========================
//
// 所有者不一致・存在しない場合のいずれもundefinedを返す
// (core/tact-project/store.tsのgetProject()と同じ規約、呼び出し元で
// 一律404等にするため区別しない)。

export async function getConversation(
  id: string,
  userId: string,
  accessToken: string
): Promise<Conversation | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toConversation(data as ConversationRow);

}

// =========================
// listConversations
// =========================
//
// 並び順はupdated_at降順(既存のlistConversations()/listProjects()と
// 同じ既存規約)。

export async function listConversations(
  userId: string,
  accessToken: string,
  limit: number = 30,
  projectId?: string | null
): Promise<ConversationSummary[]> {

  const client = createRequestScopedClient(accessToken);

  let query = client
    .from("tact_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", userId);

  // Phase74: projectId省略時は全件(Chat History)、指定時はそのProject
  // (Folder)配下のみに絞り込む。nullを明示的に渡した場合は「未所属の
  // Conversationのみ」を返す(is()で正しくNULL比較する、.eq()はNULLを
  // 一致させないPostgREST既存仕様のため)。
  if (projectId !== undefined) {
    query = projectId === null
      ? query.is("project_id", null)
      : query.eq("project_id", projectId);
  }

  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toConversationSummary(row as ConversationRow));

}

// =========================
// getConversationMessages
// =========================

export async function getConversationMessages(
  conversationId: string,
  accessToken: string
): Promise<ConversationMessage[]> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_conversation_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const messages = (data ?? []).map((row) => toConversationMessage(row as ConversationMessageRow));
  if (messages.length === 0) return messages;

  const { data: links, error: linksError } = await client
    .from("tact_conversation_message_attachments")
    .select("message_id, position, tact_attachments(id, original_filename, mime_type, file_size_bytes, extraction_status)")
    .in("message_id", messages.map((message) => message.id))
    .order("position", { ascending: true });
  if (linksError) throw linksError;

  const attachmentsByMessage = new Map<string, ConversationMessageAttachment[]>();
  for (const link of (links ?? []) as unknown as ConversationMessageAttachmentRow[]) {
    if (!link.tact_attachments) continue;
    const item: ConversationMessageAttachment = {
      id: link.tact_attachments.id,
      filename: link.tact_attachments.original_filename,
      mimeType: link.tact_attachments.mime_type,
      sizeBytes: link.tact_attachments.file_size_bytes,
      extractionStatus: link.tact_attachments.extraction_status,
    };
    const current = attachmentsByMessage.get(link.message_id) ?? [];
    current.push(item);
    attachmentsByMessage.set(link.message_id, current);
  }

  return messages.map((message) => ({
    ...message,
    attachments: attachmentsByMessage.get(message.id) ?? [],
  }));

}

// =========================
// bumpConversationUpdatedAt (internal helper)
// =========================
//
// Phase64でtact_conversations.updated_atの自動更新triggerを確認した
// 結果、既存Legacy conversationsテーブルと違い、tact_conversationsには
// triggerが存在しない(Phase64のmigrationはtriggerを追加しなかった、
// 絶対条件Section10「Evidenceなしにtriggerを追加しない」の帰結)。
// そのため、Conversation Stateを変更する操作(Message追加・Execution
// Record記録・Clarification状態変更)はApplication Layer側で明示的に
// updated_atを更新する。

async function bumpConversationUpdatedAt(
  conversationId: string,
  userId: string,
  accessToken: string
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

}

// =========================
// appendConversationMessage
// =========================
//
// 通常のuser/assistant発言を追加する(message_typeなし)。

export async function appendConversationMessage(
  conversation: Conversation,
  accessToken: string,
  role: ConversationMessageRole,
  content: string,
  executionRecordId?: string
): Promise<ConversationMessage> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_conversation_messages")
    .insert({
      conversation_id: conversation.id,
      role,
      content,
      execution_record_id: executionRecordId ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  await bumpConversationUpdatedAt(conversation.id, conversation.userId, accessToken);

  return toConversationMessage(data as ConversationMessageRow);

}

/**
 * Persists a user message, links, and linked-retention transition atomically.
 * Messages are append-only, so this must not rely on a client-side DELETE
 * compensation path.
 */
export async function appendConversationMessageWithAttachments(
  conversation: Conversation,
  accessToken: string,
  content: string,
  attachmentIds: string[]
): Promise<ConversationMessage> {
  const client = createRequestScopedClient(accessToken);
  const { data, error } = await client.rpc("append_tact_conversation_message_with_attachments", {
    p_conversation_id: conversation.id,
    p_content: content,
    p_attachment_ids: attachmentIds,
  });
  if (error) throw error;

  const rows = data as ConversationMessageRow[] | null;
  const row = rows?.[0];
  if (!row) throw new Error("Attachment message was not returned.");

  return toConversationMessage(row);
}

// =========================
// recordClarificationQuestion
// =========================
//
// Phase63 Section9のWrite Orderingをそのまま実装する:
//   1. Conversationは既に存在する前提(呼び出し元が保持)
//   2. Clarification Message INSERT(この関数の責務)
//   3. Conversation.pending_clarification_message_id UPDATE
//      (Messageが存在してから設定、FK制約を満たすための順序)
//
// 絶対条件(Phase61〜65の一貫した設計): Clarification short-circuit時は
// ExecutionRecordを作らない。この関数はExecutionRecordに一切触れない。

export async function recordClarificationQuestion(
  conversation: Conversation,
  accessToken: string,
  question: string
): Promise<ConversationMessage> {

  const client = createRequestScopedClient(accessToken);

  const { data: messageData, error: messageError } = await client
    .from("tact_conversation_messages")
    .insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: question,
      message_type: "clarification_question",
      execution_record_id: null,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (messageError) {
    throw messageError;
  }

  const message = toConversationMessage(messageData as ConversationMessageRow);

  const { error: conversationError } = await client
    .from("tact_conversations")
    .update({
      pending_clarification_message_id: message.id,
      pending_clarification_answered_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id)
    .eq("user_id", conversation.userId);

  if (conversationError) {
    throw conversationError;
  }

  return message;

}

// =========================
// recordClarificationAnswer
// =========================
//
// Phase68修正: 回答は通常のuser messageとして記録するだけに留める
// (message_typeなし)。Phase65時点の実装はこの関数自身がanswered_atを
// 即座に設定していたが、Phase65〜67ではこの関数もrecordClarificationAnswer()
// 自体も実際にはrun-timeで一度も呼ばれておらず(Phase67の
// runConversationOrchestration()はappendConversationMessage()を直接
// 使用していた)、Phase68 Decision F(Section7/9)が確定した意味論
// ——pending_clarification_answered_atは「回答を受け取った時点」ではなく
// 「その回答によるOrchestrator再実行が成功した時点」でのみ設定する
// ——と矛盾していたため、ここで修正する(Section10「既存store.tsの
// 責務を確認し、必要であれば最小限の関数拡張を行う」の範囲内)。
// answered_atの設定はclearPendingClarification()の責務に一本化する。

export async function recordClarificationAnswer(
  conversation: Conversation,
  accessToken: string,
  answer: string
): Promise<ConversationMessage> {

  return appendConversationMessage(
    conversation,
    accessToken,
    "user",
    answer
  );

}

// =========================
// isClarificationQuestionMessage (純粋関数、Phase68)
// =========================
//
// getPendingClarification()の防御的チェック(Section4)を独立した
// 純粋関数として切り出す(DBアクセスなしにテストできるようにするため)。

export function isClarificationQuestionMessage(message: ConversationMessage): boolean {
  return message.messageType === "clarification_question";
}

// =========================
// getPendingClarification
// =========================
//
// conversation.pendingClarificationMessageIdが未設定ならDBへ問い合わせず
// 即座にnullを返す(Phase55のgetPendingClarification()と同じ「安全側で
// 推測しない」方針)。

export async function getPendingClarification(
  conversation: Conversation,
  accessToken: string
): Promise<PendingClarification | null> {

  if (!conversation.pendingClarificationMessageId) {
    return null;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_conversation_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", conversation.pendingClarificationMessageId)
    .eq("conversation_id", conversation.id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    // 参照先messageが見つからない(データ不整合)。推測で復元しない
    // (Phase55と同じ安全側の方針)。
    return null;
  }

  const message = toConversationMessage(data as ConversationMessageRow);

  // Phase68 Section4: 取得対象はmessage_type="clarification_question"で
  // あることを前提とするが、DB状態が不整合(pending_clarification_message_id
  // が何らかの理由でclarification_question以外のmessageを指している)
  // だった場合は安全側に倒れ、推測でClarificationとして扱わずnullを返す
  // (「参照先が存在しない」場合と同じ扱い)。判定自体は独立した純粋関数
  // (isClarificationQuestionMessage())へ切り出し、DBアクセスなしに
  // テストできるようにする。
  if (!isClarificationQuestionMessage(message)) {
    return null;
  }

  return {
    messageId: message.id,
    question: message.content,
    answeredAt: conversation.pendingClarificationAnsweredAt ?? null,
  };

}

// =========================
// clearPendingClarification
// =========================
//
// Execution成功時にのみ呼ばれる想定(Phase63 Decision E: "executed"を
// 独立状態として永続化せず、この呼び出しが"cleared"への遷移を担う)。
//
// Phase68拡張(Section10「既存store.tsの責務を確認し、必要であれば
// 最小限の関数拡張を行う」): answeredAtを省略した場合は従来通り両方
// nullにする(Phase65時点の呼び出し元が無かったため後方互換上の懸念は
// ないが、デフォルト値として安全側を維持する)。Answer再実行が成功した
// 場合は、呼び出し元(orchestration.ts)がanswered timestampを明示的に
// 渡すことで、pending_clarification_message_id=null かつ
// pending_clarification_answered_at=<回答が反映され実行が成功した時刻>
// という最終状態にする(Phase68 Section6/10で確定した意味論)。

export async function clearPendingClarification(
  conversation: Conversation,
  accessToken: string,
  answeredAt?: string
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_conversations")
    .update({
      pending_clarification_message_id: null,
      pending_clarification_answered_at: answeredAt ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id)
    .eq("user_id", conversation.userId);

  if (error) {
    throw error;
  }

}

// =========================
// recordExecution
// =========================
//
// executionIdが指定された場合(Orchestrator実行時、OrchestrationResult.
// executionIdをそのまま渡す想定、Phase63 Section11)はそのIDでINSERTする。
// 省略時(Research/Chat/Core実行時)はgen_random_uuid()相当のIDを
// アプリケーション側で生成する(tact_execution_records.idにDB defaultを
// 設定していないため、Phase64のmigration設計通り、必ず明示的に
// IDを渡す必要がある)。

export async function recordExecution(
  conversation: Conversation,
  accessToken: string,
  capability: ExecutionCapability,
  input: string,
  status: ExecutionStatus,
  executionId?: string
): Promise<ExecutionRecord> {

  const client = createRequestScopedClient(accessToken);

  const id = executionId ?? crypto.randomUUID();

  const { data, error } = await client
    .from("tact_execution_records")
    .insert({
      id,
      conversation_id: conversation.id,
      capability,
      input,
      status,
    })
    .select(EXECUTION_RECORD_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  await bumpConversationUpdatedAt(conversation.id, conversation.userId, accessToken);

  return toExecutionRecord(data as ExecutionRecordRow);

}

// =========================
// saveConversation
// =========================
//
// Conversationオブジェクト自体の可変フィールド(title)を明示的に
// 反映するための関数。pending_clarification_*系はrecordClarification*/
// clearPendingClarification()が個別に担うため、ここでは重複更新しない
// (呼び出し元がconversationオブジェクトのpending系フィールドを直接
// 書き換えてこの関数へ渡すという誤用を避けるため、意図的にtitleのみを
// 対象とする)。

export async function saveConversation(
  conversation: Conversation,
  accessToken: string
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_conversations")
    .update({
      title: conversation.title ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id)
    .eq("user_id", conversation.userId);

  if (error) {
    throw error;
  }

}

// =========================
// linkConversationArtifact (Phase75)
// =========================
//
// Artifact Mutation発生時、Conversationがどのtact_artifacts行を
// 育てているかを記録する。既にartifact_idが設定済みの場合は
// 呼び出し元(orchestration.ts)が新規作成をスキップするため、
// この関数は「まだ紐付いていないConversationへ初めて紐付ける」
// 場面でのみ呼ばれる想定(既存の紐付けを上書きする用途はPhase75では
// 想定しない、絶対条件9「既存内容を壊さない」と同じ精神)。

export async function linkConversationArtifact(
  conversation: Conversation,
  accessToken: string,
  artifactId: string
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_conversations")
    .update({
      artifact_id: artifactId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id)
    .eq("user_id", conversation.userId);

  if (error) {
    throw error;
  }

}
