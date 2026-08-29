// =========================
// TACT Conversation — Domain Types (Phase 65)
// =========================
//
// Phase60〜64で確定したCanonical Conversation Architectureのdomain型。
// core/conversation/*(Legacy、Frozen)の型をそのままimportしない
// (Phase61〜64の絶対条件)。ただし、命名規則(camelCase、DB行の
// snake_case→domain camelCase変換をstore.ts側で吸収する構成)は
// core/conversation/types.tsおよびcore/tact-project/store.tsの
// 既存Patternをそのまま踏襲する。
//
// 重要(Phase63 Section8 / Invariant 1): Conversationはmessages配列や
// currentOutputのような可変オブジェクトグラフを埋め込まない
// (core/conversation/types.tsのConversationとの意図的な違い)。
// tact_conversation_messages / tact_execution_recordsは正規化された
// 別テーブルであり、それぞれ独立したCRUD関数で取得・追加する
// (Section「Function Contract」参照)。

export interface Conversation {

  id: string;

  userId: string;

  title?: string | null;

  // Phase74: core/tact-project(Phase30/31)への参照(Project = Folder、
  // Phase73 Investigation Case B)。未所属のConversationも引き続き
  // 成立する(nullable、既存Conversationへの後方互換)。
  projectId?: string | null;

  // Phase75: core/tact-artifact(Artifact Mutation Architecture)への
  // 参照。絶対条件: supabase/migrations/
  // 20260827000000_create_tact_artifacts.sqlはユーザー承認待ちで
  // 実DBへ未適用のため、store.ts側はこのフィールドをまだ読み書き
  // しない(常にundefinedのまま)。migration適用後にstore.tsの
  // SELECT/INSERT列へ追加する(Phase75完了報告のDeferred Decisions
  // 参照)。型のみ先行して定義し、Artifact Mutationロジック
  // (core/tact-conversation/artifactMutation.ts)が参照できるように
  // しておく。
  artifactId?: string | null;

  createdAt: string;

  updatedAt: string;

  // Phase55のClarification Persistence設計をそのまま踏襲(Pattern reuse)。
  // 質問文・元入力そのものはtact_conversation_messagesから導出する
  // (複製しない、Phase54 Decision A)。
  pendingClarificationMessageId?: string | null;

  pendingClarificationAnsweredAt?: string | null;

}

// 一覧表示用の軽量型(core/conversation/types.tsのConversationSummaryと
// 同じ位置づけ)。
export interface ConversationSummary {

  id: string;

  title?: string | null;

  // Phase74: 左サイドバーのChat History/Project別表示に使う
  // (一覧APIから絞り込み・グルーピングできるようにするため)。
  projectId?: string | null;

  createdAt: string;

  updatedAt: string;

}

export type ConversationMessageRole = "user" | "assistant";

export type ConversationMessageType = "clarification_question";

export interface ConversationMessage {

  id: string;

  conversationId: string;

  role: ConversationMessageRole;

  content: string;

  messageType?: ConversationMessageType | null;

  executionRecordId?: string | null;

  attachments?: ConversationMessageAttachment[];

  createdAt: string;

}

export interface ConversationMessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractionStatus: "pending" | "processing" | "ready" | "failed" | "unavailable";
}

export type ExecutionCapability =
  | "research"
  | "chat"
  | "core_push"
  | "orchestrator";

export type ExecutionStatus = "completed" | "failed" | "partial";

export interface ExecutionRecord {

  id: string;

  conversationId: string;

  capability: ExecutionCapability;

  input: string;

  status: ExecutionStatus;

  createdAt: string;

}

// Phase54 Section4 / Phase63 Section7の設計通り、question/originalInputは
// このオブジェクト自体には保持せず、呼び出し元がConversationMessageから
// 取得した値をそのまま使う想定。ここでは「pendingであること」自体の
// 最小限の表現のみ持つ。
export interface PendingClarification {

  messageId: string;

  question: string;

  answeredAt: string | null;

}
