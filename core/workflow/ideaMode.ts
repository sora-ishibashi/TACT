// =========================
// ideaMode (STEP39)
// =========================
//
// composedTask(=context.userInput。全Agentが"Original User Request"
// として参照する文字列)へ埋め込む、Idea Mode検出用の固定マーカー。
//
// なぜここに置くか:
// このマーカーは core/conversation/reconstructTask.ts(Conversation層、
// composedTaskへマーカーを埋め込む側)と core/workflow/runAgent.ts
// (Workflow層、context.userInputからマーカーを検出する側)の
// 両方から参照される。既存のimport方向(Conversation→Workflowへは
// 依存するが、Workflow→Conversationへは依存しない)を壊さないよう、
// Workflow層であるこのファイルに定義し、Conversation層側が
// ここから読み込む形にする。
//
// runWorkflow()・runAgent()の関数シグネチャは変更せず、既存の
// 「文字列マーカーをcomposedTaskへ埋め込み、必要なAgentが
// context.userInputから検出する」パターン(STEP17の
// FULL_REWRITE_MARKER等と同じ考え方)を再利用するための定数。
export const IDEA_MODE_MARKER =
  "今回の会話はIdea Mode(まだ正解のない仮説・アイデアを検討する会話)です。";
