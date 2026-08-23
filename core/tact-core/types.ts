// =========================
// TACT Core — Decision / CoreCapability (STEP175)
// =========================
//
// 最重要設計原則(STEP175絶対条件14): TACT Coreを巨大なGod Objectに
// しない。CoreCapabilityは「知る→判断する→必要な能力へ渡す→結果を
// 理解する→重要なものを記憶する」という境界だけを持ち、Research/
// Design/Meetingそのものの処理はここに含めない。
//
// 依存方向(STEP175絶対条件10): TACT Core → 既存能力/DB/LLM、が
// 将来の方針。STEP175時点ではこのファイルは既存コード
// (core/auth・core/context・core/conversation・core/brain・core/llm等)
// を一切importしない(型のみの設計段階のため)。

import { CoreMemory, MemoryType } from "./memory/types";
import { KnowledgeItem, KnowledgeKind, Example } from "./knowledge/types";
import { CoreExecution } from "./execution/types";
import { CoreContext } from "./context/types";

// =========================
// Decision
// =========================
//
// 「このプロジェクトではA案を採用」「SNSではこのトーンを使用」
// 「今後この資料形式を標準とする」等、TACT Coreが「何を決めたか」を
// 保持する(STEP175絶対条件6)。CoreMemory(memory/types.ts)とは
// 意図的に分離する: Memoryは「継続的な文脈・傾向」、Decisionは
// 「特定時点で下された、より確定的な決定事項」という違いを持つ。

export type DecisionScope =
  | "user"
  | "organization"
  | "project"
  | "conversation";

export interface Decision {

  id: string;

  scope: DecisionScope;

  decision: string;

  reason?: string;

  source?: string;

  createdAt: string;

}

// =========================
// CoreCapability
// =========================
//
// TACT Coreが将来の「司令塔」として外部(TACT Research/TACT Design/
// TACT Meeting、および将来的にはLegacy Workflow Engine)へ提供する
// 能力の境界。STEP175では型契約のみを定義し、DBへの実接続は行わない
// (core/tact-core/mockCoreCapability.tsが型契約確認用の
// in-memory最小実装を持つのみ)。

export interface LoadContextParams {

  userId?: string;

  organizationId?: string;

  projectId?: string;

  conversationId?: string;

}

export interface RetrieveMemoryParams extends LoadContextParams {

  type?: MemoryType;

  // Phase 4(TACT Orchestrator Memory-aware Context Sharding)で追加。
  // RetrieveKnowledgeParams/RetrieveExamplesParamsは既にSTEP177で
  // query(簡易keyword relevance検索)を持っていたが、
  // RetrieveMemoryParamsだけこのフィールドが無く、typeによる絞り込み
  // しかできないという既存の非対称が存在した(STEP177時点では
  // Memoryへのrelevance検索を要求する呼び出し元が無かったための
  // 未実装であり、意図的な設計上の除外ではない)。TACT Orchestratorが
  // Taskごとに関連するMemoryだけを取得する必要があるため、Knowledge/
  // Exampleと同じ意味論のqueryをここでも追加する。新しいVector DB/
  // Embeddingは導入せず、既存のscoreQueryRelevance/applyQueryAndLimit
  // (mockCoreCapability.ts・supabaseCoreCapability.tsに既存)をそのまま
  // Memoryにも適用する形で対応する。省略時(undefined)は既存呼び出し元
  // と完全に同じ挙動(絞り込みなし、typeとlimitだけを適用)のまま。
  query?: string;

  // STEP177: 件数制限。省略時は制限なし(全件)。
  limit?: number;

}

export interface RetrieveKnowledgeParams extends LoadContextParams {

  kind?: KnowledgeKind;

  // STEP177: 簡易keyword relevance検索に使用する(mockCoreCapability.ts
  // 参照)。Embedding/Vector検索は今回実装しない。
  query?: string;

  // STEP177: 件数制限。省略時は制限なし(全件)。
  limit?: number;

}

export interface RetrieveExamplesParams extends LoadContextParams {

  tags?: string[];

  // STEP177: Knowledgeと同じ簡易keyword relevance検索。
  query?: string;

  // STEP177: 件数制限。省略時は制限なし(全件)。
  limit?: number;

}

export interface CoreCapability {

  loadContext(
    params: LoadContextParams
  ): Promise<CoreContext>;

  retrieveMemory(
    params: RetrieveMemoryParams
  ): Promise<CoreMemory[]>;

  retrieveKnowledge(
    params: RetrieveKnowledgeParams
  ): Promise<KnowledgeItem[]>;

  retrieveExamples(
    params: RetrieveExamplesParams
  ): Promise<Example[]>;

  recordMemory(
    memory: Omit<CoreMemory, "id" | "createdAt" | "updatedAt">
  ): Promise<CoreMemory>;

  recordKnowledge(
    knowledge: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt">
  ): Promise<KnowledgeItem>;

  recordExample(
    example: Omit<Example, "id" | "createdAt">
  ): Promise<Example>;

  recordDecision(
    decision: Omit<Decision, "id" | "createdAt">
  ): Promise<Decision>;

  recordExecution(
    execution: Omit<CoreExecution, "id" | "createdAt">
  ): Promise<CoreExecution>;

}
