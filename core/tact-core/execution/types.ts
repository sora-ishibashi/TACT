// =========================
// TACT Core — Execution (STEP175)
// =========================
//
// 責務分離(STEP175絶対条件7):
//   ExecutionRecord (core/context/types.ts)
//     = LLM / Workflow実行の技術ログ。TaskProfile・modelTier・
//       cost・actualProvider等、Legacy Workflow Engineの内部動作を
//       記録する。STEP175では一切変更しない。
//   CoreExecution (このファイル)
//     = TACT Coreが「過去に何をしたか」を理解するための、より
//       抽象化された経験の記録。技術的な詳細(どのモデルを使ったか等)
//       には立ち入らず、「何を・どの能力で・どの程度うまく実行したか」
//       だけを持つ。
//
// 既存ExecutionRecordと完全に同一の型にしない、というSTEP175の
// 指示どおり、フィールドを意図的に最小化している。
// relatedExecutionRecordIdで技術ログ側と紐付けられる余地だけ残す
// (STEP175では実際の紐付けロジックは実装しない)。

export type CoreExecutionScope =
  | "user"
  | "organization"
  | "project"
  | "conversation";

export type CoreExecutionOutcome =
  | "success"
  | "failure"
  | "partial";

export interface CoreExecution {

  id: string;

  scope: CoreExecutionScope;

  // どの能力(将来のTACT Research/TACT Design/TACT Meeting、または
  // 現行のLegacy Workflow Engine)が実行したか。STEP175時点では
  // 固定の列挙型にせず、自由文字列とする(能力の集合自体がまだ
  // 確定していないため)。
  capability: string;

  // 人間が読める形の実行内容の要約。
  summary: string;

  outcome: CoreExecutionOutcome;

  // core/context/types.tsのExecutionRecord(技術ログ)との紐付け用。
  // STEP175では実際の値を設定するロジックは実装しない。
  relatedExecutionRecordId?: string;

  createdAt: string;

}
