import type { CoreReferenceScope } from "./types";

// =========================
// MemoryCandidate (Phase 5)
// =========================
//
// 「Agentの出力」と「TACT Memoryへ書き込む価値がある情報」は別物という
// のがPhase 5の中核方針(絶対条件: Agent結果をそのまま保存しない)。
// MemoryCandidateは、この2つの間に置く中間表現。TaskExecutionSummary
// (core/tact-orchestrator/task.ts)が「Taskが何をしたか」の記録
// であるのに対し、MemoryCandidateは「その結果のうち、長期記憶として
// 保持する価値があるかもしれない一部分」を表す、まだ採否が決まって
// いない候補である。
//
// 既存型との関係(絶対条件: 既存型と重複する場合は新規型を作らず
// 既存型を拡張する):
//   - content/confidence/importance/sourceは、core/tact-core/memory/
//     types.tsのCoreMemoryと意図的に同じ語彙・スケールを使う
//     (importance: 1〜10、confidence: low/medium/high、source: 自由文字列)。
//     ただしCoreMemory自体は拡張しない(DB列が存在しないevidence/
//     originTask等の情報をCoreMemoryに追加するとDB schemaとの乖離が
//     生まれるため)。MemoryCandidateは「DBへ書く前の、Orchestrator側
//     だけで完結する中間表現」として独立させる。
//   - scopeはcore/tact-orchestrator/types.tsのCoreReferenceScope
//     (Phase 1で定義済み、MemoryScope/KnowledgeScopeと同じ値集合)を
//     再利用する。
export type MemoryCandidateType =
  // ユーザーの継続的な好み・方針(例: 「今後はできるだけ簡潔に」)。
  | "user_preference"
  // 特定プロジェクトについて長期的に使える情報(例: 「このプロジェクト
  // ではFigmaを使う」)。STEP208時点でProject Scopeの永続化は未実装
  // のため、Phase 5では実際にはUser Scopeの下に記録される
  // (memoryWriter.tsのコメント参照)。
  | "project_memory"
  // Research等が発見した、将来再利用できる可能性が高い知識。
  // recordMemory()ではなくrecordKnowledge()(kind:"reference")で
  // 永続化する(既存2つのrecord系メソッドを両方再利用するため)。
  | "knowledge_memory"
  // 何を・なぜ・何を根拠に決めたか、というDecisionの記録。
  | "decision_memory"
  // 予約(Phase 5では生成しない、絶対条件: Organization Memoryの本格
  // 実装はスコープ外)。将来Organization Scope永続化が実装された際に
  // 使う値としてTypeScript上でだけ先に定義しておく。
  | "organization_memory"
  // 予約(Phase 5では生成しない、絶対条件16: Execution Memoryは
  // 将来Phase)。実行メタデータ(cost/duration等)を将来Core化する際に
  // 使う値としてTypeScript上でだけ先に定義しておく。
  | "execution_memory"
  | "other";

// STEP195以来の既存方針(ResearchEvidenceItem)と同じく、根拠の実体
// (Evidence全文)は複製せず、追跡に必要な最小限の情報だけを持つ。
export interface MemoryCandidateEvidence {

  source?: string;

  snippet?: string;

}

export interface MemoryCandidate {

  // Phase36絶対条件: contentには「そのままユーザーへ提示されても
  // 自然な内容」だけを保存する。coreOnlyAnswer.tsのCore-only
  // Answerability(STEP180)が、この値を一切加工せずそのまま回答文と
  // して返す設計のため(絶対条件: Core-only側は変更しない)、"Q:/A:"の
  // ような内部形式・監査用の文言をここへ混ぜない。質問文等の付随情報は
  // 下記descriptionへ分離する。
  content: string;

  // Phase36: このMemory Candidateの元になった質問・依頼文
  // (例: Task.description)。KnowledgeItem.description(既存フィールド、
  // DB schema変更不要)へそのまま渡される。coreOnlyAnswer.tsは
  // この値を回答生成に使わない(contentのみを読む)ため、Core-only
  // Answerabilityの挙動には影響しない。一方、既存のKnowledge検索
  // (core/tact-core/supabaseCoreCapability.tsのretrieveKnowledge()が
  // 既にtitle/description/content/tagsを結合してrelevance判定して
  // いる、STEP208-L)には引き続き反映されるため、再検索時の一致精度は
  // 維持される。
  description?: string;

  memoryType: MemoryCandidateType;

  scope: CoreReferenceScope;

  ownerId?: string;

  // CoreMemory.source/KnowledgeItem.sourceと同じ「自由記述の出典」
  // フィールド。Phase 5では
  // "orchestrator:<origin>:task=<taskId>"という命名規則で、どのTask
  // からこの候補が生まれたかを追跡可能にする(DB schemaを増やさずに
  // provenanceを確保する、STEP208-Lの`source`自由記述という既存契約を
  // そのまま利用)。
  source: string;

  evidence?: MemoryCandidateEvidence[];

  confidence: "low" | "medium" | "high";

  // 1(低)〜10(高)。CoreMemory/Exampleの既存importanceスケールと揃える。
  importance: number;

  // 情報の鮮度分類。複雑な自動expiration計算は行わない(絶対条件10)。
  // "durable"  = 長期間有効と見込まれる(例: ユーザーの継続的な好み)
  // "volatile" = 将来変わる可能性が高い(例: 現在のUI構成の説明)
  freshness: "durable" | "volatile";

  originTaskId: string;

  // Legacy Agent概念(AgentId)は使わない(絶対条件: Legacy Agent構造を
  // 復活させない)。代わりにTask.assignedCapability(またはchatの場合
  // undefined)をそのまま保持する。
  originCapability?: string;

  createdAt: string;

}
