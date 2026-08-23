// =========================
// TACT Core — Memory (STEP175)
// =========================
//
// 重要な区別(STEP175絶対条件3): 既存のtact_memory
// (core/brain/memory.ts、core/brain/types.tsのBrainRule/
// ImprovementProposal)は「Reviewerが発見したAgent改善ルール」が
// 中心であり、responsibility(責務)が異なる。あちらはLegacy Workflow
// Engineの自己改善専用データであり、今回は一切変更しない。
//
// ここで定義するCoreMemoryは、「TACTがユーザー・組織・プロジェクトに
// ついて将来の判断に利用するため保持する情報」(STEP175の定義)を表す、
// 全く別の概念・別のデータである。将来的にDB化する場合も、既存の
// tact_memoryテーブルへ混在させず、専用テーブル(例:
// tact_core_memories)を新設する方針を想定する(STEP175では
// migrationを行わない)。

// scope単位でこのファイル内に閉じて定義する(他モジュールとの
// 循環参照を避け、各Core概念モジュールを自己完結させるため)。
export type MemoryScope =
  | "user"
  | "organization"
  | "project"
  | "conversation";

// STEP175の指示にある具体例(User preference / Project decision(※
// Decisionとして別に定義するため、Memory側はrule寄りの意味に限定)/
// Organization rule / Past successful approach / Important context /
// Working preference)を型として表現する。"other"を残し、将来の
// 分類拡張を型変更なしで許容する。
export type MemoryType =
  | "preference"
  | "rule"
  | "successful_approach"
  | "context"
  | "working_preference"
  | "other";

export interface CoreMemory {

  id: string;

  scope: MemoryScope;

  // STEP205: core/tact-core/knowledge/types.tsのKnowledgeBase.ownerIdと
  // 同じ意味上の対応(scope==="user"→ユーザーID、"organization"→
  // organization ID、"project"→project ID、"conversation"→
  // conversation ID)。CoreMemoryはKnowledgeBaseを継承しない独立した
  // interfaceのため(このファイル冒頭のコメント通り、意図的に別概念
  // として設計されている)、同じフィールドを個別に持つ。Organization/
  // ProjectのDB実体・所属関係は今回新設しない。
  ownerId: string;

  type: MemoryType;

  content: string;

  // 1(低)〜10(高)。既存tact_memoryのimportance整数スケール
  // (core/brain/memory.ts参照)と揃え、将来の統計比較を容易にする
  // (ただしテーブル自体は共有しない)。
  importance: number;

  confidence: "low" | "medium" | "high";

  // どこから得られた記憶か(例: "reviewer" / "user_feedback" /
  // "conversation:<id>" 等、自由記述)。
  source?: string;

  createdAt: string;

  updatedAt: string;

}
