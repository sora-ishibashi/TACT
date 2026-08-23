// =========================
// TACT Design — Public Types (STEP178)
// =========================
//
// core/tact-research/types.ts(STEP176/177)と同じ思想で設計する。
// 重要(STEP178絶対条件): 外部公開APIにAgent型(core/agents/types.ts
// のAgent/AgentId)を一切露出しない。呼び出し元は「designという能力」
// だけを意識すればよい。
//
// TACT Designは「資料生成機能」ではなく、「TACT Coreに蓄積された
// 過去の良い成果物(Example)・知識(Knowledge)・記憶(Memory)を
// 参照しながら成果物を作るCapability」として設計する(STEP178目的)。
//
// 既存のcomponents/design/*(DocumentModel/DesignIntent/
// DocumentOperationによる、資料の対話的編集プロトタイプ)とは
// 責務が異なるため、型を混在させない(STEP178-A監査結果)。
// 既存Design UIは「今開いている1つの資料をどう編集するか」を
// 扱うのに対し、TACT Design Capabilityは「Core Contextを踏まえて
// 何を作るか」を扱う。将来的に、このCapabilityの出力
// (DesignResult.output)を既存DocumentModelへ変換するAdapterを
// 別途設けることは考えられるが、STEP178では行わない。

import type { CoreContext, CoreMemory, KnowledgeItem, Example } from "../tact-core";

export interface DesignOptions {

  // 将来の生成物の種類(スライド/レポート/ポスター等)を絞り込む
  // 差し込み口。STEP178では実際の生成ロジックが参照しないため
  // 値を受け取っても使用しない(core/tact-research/types.tsの
  // ResearchOptions.maxResultsと同じ位置づけ)。
  category?: string;

}

export interface DesignParams {

  // ユーザーの依頼内容(自然言語)。「prompt」ではなく「request」を
  // 採用する(STEP178指示の公開API例に合わせる)。
  request: string;

  // 呼び出し元が事前にCoreCapability.loadContext()で取得済みの
  // CoreContext(knowledge/memories/examplesを含む)をそのまま渡す。
  // Design自身はCoreへ「取得」の問い合わせを行わない
  // (core/tact-research/runResearch.tsと同じ境界)。
  context: CoreContext;

  options?: DesignOptions;

}

export interface DesignMetadata {

  usedKnowledgeCount: number;

  usedMemoryCount: number;

  usedExampleCount: number;

  // 「この成果物はCoreのどのお手本・知識・記憶を使って作られたのか」
  // を将来的に追跡できるようにするためのID一覧
  // (core/tact-research/types.tsのResearchMetadataと同じ考え方)。
  usedKnowledgeIds: string[];

  usedMemoryIds: string[];

  usedExampleIds: string[];

  durationMs: number;

  // STEP178時点では常にtrue(実LLM/実Agentへ接続していないため)。
  mocked: boolean;

}

export interface DesignResult {

  success: boolean;

  output: string;

  metadata: DesignMetadata;

  errorMessage?: string;

}

// mockDesignEngine.tsが受け取る、Coreから渡された関連文脈の型
// (再exportではなく、Design側が「自分が何を必要とするか」を
// 明示するための型エイリアス。core/tact-research/types.tsと同じ形)。
export type RelevantKnowledge = KnowledgeItem[];
export type RelevantMemories = CoreMemory[];
export type RelevantExamples = Example[];
