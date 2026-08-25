// =========================
// Conversation
// =========================
//
// 「1回のWorkflow実行」のための実行コンテキストである WorkflowContext
// (core/context/types.ts)とは責務が異なる。
//
// WorkflowContext: 1回のWorkflow実行の間だけ生きる実行コンテキスト
// Conversation   : 会話セッションとして長期間保持される状態
//
// この2つを同一視しない。ConversationはWorkflowRunを介して
// WorkflowContextの実行結果(特にcontext.outputs.writer)を参照する。

// =========================
// ConversationMessage
// =========================

export type ConversationRole = "user" | "assistant";

// Phase55: roleとは独立した軸。通常のメッセージはmessageTypeを持たず
// (undefined)、Clarification質問(role:"assistant")だけが
// "clarification_question"を持つ。汎用的なMessage種別taxonomyは
// 作らない(値は現時点でこの1種類のみ、Phase52〜55の絶対条件)。
export type ConversationMessageType = "clarification_question";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  messageType?: ConversationMessageType;
}

// =========================
// WorkflowRun
// =========================
//
// Conversation内で発生した「1回のAI処理(既存Workflow実行)」の記録。
// 既存のWorkflow(Planner→...→Writer、Reviewer retryを含む)の
// 実行方式そのものは一切変更しない。ここではその実行結果を
// Conversationに紐付けて追跡するためだけの入れ物を用意する。

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed";

export interface WorkflowRun {
  id: string;

  // このRunの際にWorkflowへ渡した実際の入力
  // (conversation.currentTaskのスナップショット)
  input: string;

  // context.outputs のスナップショット(Writerの出力を含む)。
  // 既存のAgent出力Schemaは一切変更せず、そのまま保持する。
  outputs: Record<string, unknown>;

  status: WorkflowRunStatus;

  startedAt: string;

  completedAt?: string;

  error?: string;
}

// =========================
// ConversationAttachment (STEP32)
// =========================
//
// ユーザーがチャットに添付したファイルから、既に抽出済みのテキスト
// (画像の場合はVisionによる説明文)を表す。ファイル本体(バイナリ)は
// 保持しない。1リクエスト分の入力として扱う一時的な型であり、
// Conversation本体・DBスキーマには追加しない
// (Evidence化されたものはcore/conversation/index.tsが既存の
// seedEvidence(STEP18)/Evidenceスナップショット(STEP31)経由で
// 永続化する)。

export interface ConversationAttachment {

  fileName: string;

  mimeType: string;

  // 抽出済みのテキスト(PDF/Word/Excel/PowerPointの場合は本文、
  // 画像の場合はVisionによる説明文)。
  extractedText: string;

}

// =========================
// Conversation
// =========================

export interface Conversation {
  id: string;

  userId?: string;

  title?: string;

  createdAt: string;

  updatedAt: string;

  // 現在の作業状態を表す文字列。
  // 今回はLLMによる自動的な再構成は行わず、
  // ユーザーの追加指示を単純に積み上げる形に留める。
  currentTask: string;

  // 直近のWriter出力(context.outputs.writer)をそのまま保持する。
  // 既存のWriter出力Schemaを変更しないため、型はunknownのまま扱う。
  currentOutput: unknown;

  messages: ConversationMessage[];

  workflowRuns: WorkflowRun[];

  // Phase55(Phase52 Product Decision Clarification=B、Phase53/54で
  // 設計): 現在pendingなClarification質問を指すmessage id。undefined/
  // 未設定ならpendingなし。質問文・元入力・回答文そのものは
  // messagesから導出する(ここに複製しない、Phase54 Decision A)。
  pendingClarificationMessageId?: string;

  // 上記messageに対してユーザーが回答した時刻。undefinedならまだ
  // 未回答(pending)、設定済みなら回答済み(answered、Execution成功/
  // 失敗待ち)。Execution成功時は両フィールドをundefinedへ戻す
  // ("executed"という状態を独立して永続化しない、Phase54 Decision E)。
  pendingClarificationAnsweredAt?: string;
}

// =========================
// ConversationSummary
// =========================
//
// Conversation一覧表示用の軽量型(STEP9)。
// messages / workflowRunsを含まない。一覧取得APIは
// conversationsテーブルのみを参照するため、Conversation本体の
// フィールドのうち一覧表示に必要な部分だけを持つ。

export interface ConversationSummary {
  id: string;

  title?: string;

  currentTask: string;

  createdAt: string;

  updatedAt: string;
}
