// =========================
// SupabaseCoreCapability (STEP208)
// =========================
//
// core/tact-core/mockCoreCapability.ts(in-memory、STEP175〜)に続く、
// CoreCapability(core/tact-core/types.ts)の2つ目の実装。
// supabase/migrations/20260822000000_create_tact_core_tables.sql
// (tact_core_knowledge / tact_core_memories / tact_core_examples、
// STEP204〜207で設計・確定)を実際に読み書きする。
//
// 重要(STEP208絶対条件): 今回の永続化対象は User Scope のみ。
// Organization/Project/Conversation Scopeは、所属関係を解決する
// 仕組み自体がRepository内に存在しない(STEP203〜207で確認済み)ため、
// 実装しない。呼び出し時にこれらのscope/paramsが渡された場合は、
// 「未対応scopeへの誤変換」「全データ取得」「silent fallback」を
// 一切行わず、明示的にErrorを投げる(STEP208-J)。
//
// recordExecution()のみ例外的に「未永続化(no-op)」として扱う
// (recordDecision等と同じくthrowにしない理由): core/tact-research/
// runResearch.tsが実行結果の全分岐でcore.recordExecution()を
// 呼んでおり、これがthrowするとrunResearch()自身のtry/catchに
// 捕捉されて「Search/LLMは成功したのにResearchResult.success=false」
// という深刻なRegressionを引き起こす(STEP208-P)。CoreExecutionの
// 永続化テーブルは今回のmigration対象外(STEP206/207で確認済み)であり、
// 新規テーブル作成もLegacy tact_execution_historyの流用も禁止
// されているため、interface契約を満たす値を返しつつDBへは書き込まない
// (「既存interfaceを壊さない最小実装」を選択、STEP208-P)。
// recordDecision()は現時点でどの呼び出し元からも使われておらず
// (core/tact-research/*にrecordDecision呼び出しが存在しないことを
// 確認済み)、対応するテーブルも存在しないため、明示的なエラーとする
// (呼び出されれば即座に「未実装」と分かる方が、fakeな成功を返すより
// 安全と判断)。
//
// 実装パターン: core/conversation/store.ts(このRepositoryの既存
// 一次実装例)と同じ、「<X>Row(snake_case) + to<Domain>()純粋関数 +
// supabaseクライアントを直接使うasync関数」という構造を1ファイル内で
// セクション分けして採用する(STEP207-Lの比較検討に基づき、
// repositories/への分割は行わない)。エラー処理も同じパターン
// (`if (error) throw error;`)を踏襲する。

import { randomUUID } from "crypto";

import { supabase } from "../database/supabase";
import {
  CoreCapability,
  LoadContextParams,
  RetrieveMemoryParams,
  RetrieveKnowledgeParams,
  RetrieveExamplesParams,
  Decision,
} from "./types";
import { CoreContext } from "./context/types";
import { CoreMemory, MemoryScope, MemoryType } from "./memory/types";
import {
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeScope,
  Example,
} from "./knowledge/types";
import { CoreExecution } from "./execution/types";

// =========================
// scope/owner共通ヘルパー (STEP208-N)
// =========================
//
// 4つのDB owner列(user_id/organization_id/project_id/conversation_id)
// とCoreの単一ownerId(STEP205)の変換ロジックを1箇所に集約する。
// Organization/Project/Conversation Scopeへのアクセスは、この関数群を
// 通過した時点で必ずErrorになる(silent fallback禁止、STEP208-J)。

// Read系(LoadContextParamsを継承する4メソッド)向け。
// organizationId/projectId/conversationIdが1つでも指定されていたら、
// 対応するDB読み取り経路が存在しないため即座にErrorとする。
// userIdが未指定(未認証Research等)の場合は、呼び出し元が
// 「該当ユーザーなし」として空配列/空Contextを扱えるようundefinedを返す
// (全ユーザーのデータを返すfallbackは行わない、STEP208-D)。
function resolveUserScopeOwnerId(
  params: LoadContextParams
): string | undefined {

  if (params.organizationId || params.projectId || params.conversationId) {

    throw new Error(
      "SupabaseCoreCapability: organization/project/conversation scope " +
      "is not implemented yet (User Scope only, STEP208). " +
      "Do not call with organizationId/projectId/conversationId."
    );

  }

  return params.userId ?? undefined;

}

// Write系(record*)向け。scopeが"user"以外、またはownerIdが空の場合は
// 即座にErrorとする(Organization/Project Scopeへの書き込み経路は
// 今回実装しない、STEP208-M)。
function assertUserScopeOwner(
  scope: string,
  ownerId: string
): void {

  if (scope !== "user") {

    throw new Error(
      `SupabaseCoreCapability: recording with scope="${scope}" is not ` +
      "implemented yet (User Scope only, STEP208)."
    );

  }

  if (!ownerId) {

    throw new Error(
      "SupabaseCoreCapability: ownerId is required to record a " +
      "user-scoped Core item."
    );

  }

}

// =========================
// 簡易keyword relevance検索 (STEP208-L)
// =========================
//
// core/tact-core/mockCoreCapability.tsが既に持つ「簡易keyword
// relevance」検索(scoreQueryRelevance/applyQueryAndLimit)と全く
// 同じアルゴリズムをここでも使う。mock/Persistent間で検索意味論が
//食い違わないようにするための意図的な複製であり(mockCoreCapability.ts
// 自体は変更しない、STEP208-Y)、PostgreSQLの全文検索やEmbeddingは
// 新規導入しない(絶対条件)。

function scoreQueryRelevance(
  searchableText: string,
  query: string
): number {

  const tokens =
    query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

  if (tokens.length === 0) {
    return 0;
  }

  const lowerText = searchableText.toLowerCase();

  return tokens.filter((token) => lowerText.includes(token)).length;

}

function applyQueryAndLimit<T>(
  items: T[],
  toSearchableText: (item: T) => string,
  query: string | undefined,
  limit: number | undefined
): T[] {

  let results = items;

  if (query) {

    results = results
      .map((item) => ({
        item,
        relevance: scoreQueryRelevance(toSearchableText(item), query),
      }))
      .filter((scored) => scored.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .map((scored) => scored.item);

  }

  if (limit !== undefined) {
    results = results.slice(0, limit);
  }

  return results;

}

// =========================
// Knowledge (tact_core_knowledge)
// =========================

export interface KnowledgeRow {
  id: string;
  user_id: string | null;
  scope: string;
  kind: string;
  title: string;
  description: string | null;
  content: string;
  source: string;
  reference: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// STEP208-D: user_id = ownerIdでクエリしているため、返る行の
// user_idは論理的には常に非nullのはずだが、念のため実行時にも
// 明示的に検証する(孤児行=user_id IS NULLをCoreContextへ返さない、
// という絶対条件を型キャストだけに頼らず保証するため)。
// STEP208-T: Case D(owner ID mapping)・Case E(orphan row除外)を
// migration未適用環境でも純関数テストできるよう、DB↔Domainの
// マッピング関数(このファイル内でのみ本来使う想定)をexportする。
// 公開APIとしての利用は想定していない(CoreCapability自体は
// createSupabaseCoreCapability()経由でのみ利用する)。
export function toKnowledgeItem(row: KnowledgeRow): KnowledgeItem | null {

  if (!row.user_id) {
    return null;
  }

  return {
    id: row.id,
    scope: row.scope as KnowledgeScope,
    ownerId: row.user_id,
    source: row.source,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    kind: row.kind as KnowledgeKind,
    title: row.title,
    description: row.description ?? undefined,
    content: row.content,
    reference: row.reference ?? undefined,
    metadata: row.metadata ?? undefined,
    updatedAt: row.updated_at,
  };

}

const KNOWLEDGE_COLUMNS =
  "id, user_id, scope, kind, title, description, content, source, " +
  "reference, tags, metadata, created_at, updated_at";

// =========================
// Legacy Research Knowledge判定 (Phase38)
// =========================
//
// 背景(Phase34〜37): Phase36以前は、Research由来Knowledgeの
// contentを"Q: {質問}\nA: {回答}"という内部監査用の形式で保存
// していた。core/tact-research/coreOnlyAnswer.ts(STEP180)は
// Knowledge.contentを一切加工せずそのままユーザーへ返す設計のため、
// この内部形式がそのまま回答へ漏洩する不具合をPhase34の実測で確認
// した。Phase36で新規書き込み形式を修正済み(content=回答本文のみ、
// description=質問文)だが、実DBにはPhase37調査で確認した通り10件の
// 旧形式データが既に残っている。DBは変更しない方針(Phase37結論、
// backfillはリスクが高いため不採用)のため、読み取り時にこれらを
// 除外する。
//
// 判定条件(Phase37で実データの誤検出0件を確認済み):
//   1. source が "orchestrator:research:" で始まる(Research由来と
//      判明している場合のみ対象にする。手動Knowledge(source="upload"/
//      "user_push"等)の自然文が偶然"Q:"で始まっても対象にしない)。
//   2. content が "Q:" で始まる(Phase36以降の新形式は回答本文のみの
//      ため通常この形にならない)。
// 両方を満たす場合のみLegacyとみなす(絶対条件: content prefixだけの
// 単純な判定にしない)。
//
// exportする理由(Phase38、STEP208-Tのtoexport済みtoKnowledgeItem()と
// 同じ前例): selectKnowledgeByOwner()自体は実Supabase接続を伴うため
// 単体テストできないが、この判定ロジック自体は決定論的な純粋関数
// であり、実装と乖離しないようEvaluation Harnessから直接検証できる
// ようにする。
export function isLegacyResearchKnowledge(item: KnowledgeItem): boolean {

  return (
    item.source.startsWith("orchestrator:research:") &&
    item.content.startsWith("Q:")
  );

}

async function selectKnowledgeByOwner(
  ownerId: string,
  kind?: KnowledgeKind
): Promise<KnowledgeItem[]> {

  let queryBuilder = supabase
    .from("tact_core_knowledge")
    .select(KNOWLEDGE_COLUMNS)
    .eq("scope", "user")
    .eq("user_id", ownerId);

  if (kind) {
    queryBuilder = queryBuilder.eq("kind", kind);
  }

  const { data, error } = await queryBuilder;

  if (error) {
    throw error;
  }

  // Phase38: loadContext()・retrieveKnowledge()の両方がこの関数を
  // 経由する(唯一の共有DB取得箇所)ため、ここで除外するだけで
  // Research(Core-only含む)・Chat(Memory-aware Context)の両経路に
  // 一貫して反映される。関連度スコアリング・Knowledge Gap判定より
  // 前(呼び出し元がcontext.knowledgeを組み立てる前)に除外している
  // ため、Legacy Knowledgeが「covered」と判定されてからWeb Researchを
  // 省略してしまう、という別の問題は発生しない。
  return ((data ?? []) as unknown as KnowledgeRow[])
    .map(toKnowledgeItem)
    .filter((item): item is KnowledgeItem => item !== null)
    .filter((item) => !isLegacyResearchKnowledge(item));

}

async function insertKnowledge(
  knowledge: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt">
): Promise<KnowledgeItem> {

  assertUserScopeOwner(knowledge.scope, knowledge.ownerId);

  const { data, error } = await supabase
    .from("tact_core_knowledge")
    .insert({
      user_id: knowledge.ownerId,
      scope: knowledge.scope,
      kind: knowledge.kind,
      title: knowledge.title,
      description: knowledge.description ?? null,
      content: knowledge.content,
      source: knowledge.source,
      reference: knowledge.reference ?? null,
      tags: knowledge.tags,
      metadata: knowledge.metadata ?? null,
    })
    .select(KNOWLEDGE_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  const item = toKnowledgeItem(data as unknown as KnowledgeRow);

  if (!item) {
    throw new Error(
      "SupabaseCoreCapability: inserted knowledge row is missing user_id."
    );
  }

  return item;

}

// =========================
// Memory (tact_core_memories)
// =========================

export interface MemoryRow {
  id: string;
  user_id: string | null;
  scope: string;
  type: string;
  content: string;
  importance: number;
  confidence: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export function toCoreMemory(row: MemoryRow): CoreMemory | null {

  if (!row.user_id) {
    return null;
  }

  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    ownerId: row.user_id,
    type: row.type as MemoryType,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence as "low" | "medium" | "high",
    source: row.source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

const MEMORY_COLUMNS =
  "id, user_id, scope, type, content, importance, confidence, " +
  "source, created_at, updated_at";

async function selectMemoryByOwner(
  ownerId: string,
  type?: MemoryType
): Promise<CoreMemory[]> {

  let queryBuilder = supabase
    .from("tact_core_memories")
    .select(MEMORY_COLUMNS)
    .eq("scope", "user")
    .eq("user_id", ownerId);

  if (type) {
    queryBuilder = queryBuilder.eq("type", type);
  }

  const { data, error } = await queryBuilder;

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as MemoryRow[])
    .map(toCoreMemory)
    .filter((item): item is CoreMemory => item !== null);

}

async function insertMemory(
  memory: Omit<CoreMemory, "id" | "createdAt" | "updatedAt">
): Promise<CoreMemory> {

  assertUserScopeOwner(memory.scope, memory.ownerId);

  const { data, error } = await supabase
    .from("tact_core_memories")
    .insert({
      user_id: memory.ownerId,
      scope: memory.scope,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence,
      source: memory.source ?? null,
    })
    .select(MEMORY_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  const item = toCoreMemory(data as unknown as MemoryRow);

  if (!item) {
    throw new Error(
      "SupabaseCoreCapability: inserted memory row is missing user_id."
    );
  }

  return item;

}

// =========================
// Example (tact_core_examples)
// =========================

export interface ExampleRow {
  id: string;
  user_id: string | null;
  scope: string;
  source: string;
  tags: string[] | null;
  title: string;
  description: string | null;
  artifact_id: string | null;
  importance: number;
  reason: string | null;
  category: string | null;
  created_at: string;
}

export function toExample(row: ExampleRow): Example | null {

  if (!row.user_id) {
    return null;
  }

  return {
    id: row.id,
    scope: row.scope as KnowledgeScope,
    ownerId: row.user_id,
    source: row.source,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    title: row.title,
    description: row.description ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    importance: row.importance,
    reason: row.reason ?? undefined,
    category: row.category ?? undefined,
  };

}

const EXAMPLE_COLUMNS =
  "id, user_id, scope, source, tags, title, description, artifact_id, " +
  "importance, reason, category, created_at";

async function selectExampleByOwner(
  ownerId: string,
  tags?: string[]
): Promise<Example[]> {

  const { data, error } = await supabase
    .from("tact_core_examples")
    .select(EXAMPLE_COLUMNS)
    .eq("scope", "user")
    .eq("user_id", ownerId);

  if (error) {
    throw error;
  }

  const examples = ((data ?? []) as unknown as ExampleRow[])
    .map(toExample)
    .filter((item): item is Example => item !== null);

  // STEP208-L: mockCoreCapability.tsのretrieveExamples()と同じ
  // 「指定tagsのいずれかを含む」フィルタ。新しいPostgres配列演算子は
  // 導入せず、既に取得済みの行に対しJS側で絞り込む。
  if (!tags || tags.length === 0) {
    return examples;
  }

  return examples.filter((example) =>
    tags.some((tag) => example.tags.includes(tag))
  );

}

async function insertExample(
  example: Omit<Example, "id" | "createdAt">
): Promise<Example> {

  assertUserScopeOwner(example.scope, example.ownerId);

  const { data, error } = await supabase
    .from("tact_core_examples")
    .insert({
      user_id: example.ownerId,
      scope: example.scope,
      source: example.source,
      tags: example.tags,
      title: example.title,
      description: example.description ?? null,
      artifact_id: example.artifactId ?? null,
      importance: example.importance,
      reason: example.reason ?? null,
      category: example.category ?? null,
    })
    .select(EXAMPLE_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  const item = toExample(data as unknown as ExampleRow);

  if (!item) {
    throw new Error(
      "SupabaseCoreCapability: inserted example row is missing user_id."
    );
  }

  return item;

}

// =========================
// CoreCapability (公開API)
// =========================

export function createSupabaseCoreCapability(): CoreCapability {

  return {

    async loadContext(
      params: LoadContextParams
    ): Promise<CoreContext> {

      const ownerId = resolveUserScopeOwnerId(params);

      if (!ownerId) {

        // STEP208-D: userId未指定(未認証Research等)の場合、全ユーザーの
        // Coreを返すfallbackは行わず、空のCoreContextを返す。
        return {
          conversationId: params.conversationId,
          memories: [],
          knowledge: [],
          examples: [],
          recentExecutions: [],
        };

      }

      const [knowledge, memories, examples] = await Promise.all([
        selectKnowledgeByOwner(ownerId),
        selectMemoryByOwner(ownerId),
        selectExampleByOwner(ownerId),
      ]);

      return {
        conversationId: params.conversationId,
        memories,
        knowledge,
        examples,
        // STEP208-P: CoreExecutionは今回未永続化(recordExecution参照)
        // のため、読み戻す実行履歴は常に空。
        recentExecutions: [],
      };

    },

    async retrieveMemory(
      params: RetrieveMemoryParams
    ): Promise<CoreMemory[]> {

      const ownerId = resolveUserScopeOwnerId(params);

      if (!ownerId) {
        return [];
      }

      const items = await selectMemoryByOwner(ownerId, params.type);

      // Phase 4(TACT Orchestrator): retrieveKnowledge/retrieveExamplesと
      // 同じapplyQueryAndLimit()をここでも適用する。params.query省略時
      // (既存の全呼び出し元)は、applyQueryAndLimit()内部のif(query)が
      // falseになり、絞り込みなし+limitのみという既存挙動と完全に
      // 同じ結果を返す(非破壊)。
      return applyQueryAndLimit(
        items,
        (item) => `${item.type} ${item.content} ${item.source ?? ""}`,
        params.query,
        params.limit
      );

    },

    async retrieveKnowledge(
      params: RetrieveKnowledgeParams
    ): Promise<KnowledgeItem[]> {

      const ownerId = resolveUserScopeOwnerId(params);

      if (!ownerId) {
        return [];
      }

      const items = await selectKnowledgeByOwner(ownerId, params.kind);

      return applyQueryAndLimit(
        items,
        (item) =>
          `${item.title} ${item.description ?? ""} ${item.content} ${item.tags.join(" ")}`,
        params.query,
        params.limit
      );

    },

    async retrieveExamples(
      params: RetrieveExamplesParams
    ): Promise<Example[]> {

      const ownerId = resolveUserScopeOwnerId(params);

      if (!ownerId) {
        return [];
      }

      const items = await selectExampleByOwner(ownerId, params.tags);

      return applyQueryAndLimit(
        items,
        (item) =>
          `${item.title} ${item.description ?? ""} ${item.reason ?? ""} ${item.category ?? ""} ${item.tags.join(" ")}`,
        params.query,
        params.limit
      );

    },

    async recordMemory(
      memory
    ): Promise<CoreMemory> {

      return insertMemory(memory);

    },

    async recordKnowledge(
      knowledge
    ): Promise<KnowledgeItem> {

      return insertKnowledge(knowledge);

    },

    async recordExample(
      example
    ): Promise<Example> {

      return insertExample(example);

    },

    async recordDecision(
      decision: Omit<Decision, "id" | "createdAt">
    ): Promise<Decision> {

      // STEP208-O: 対応する永続化テーブルが存在せず(今回のmigration
      // 対象外)、現時点でどの呼び出し元からも使われていないため
      // (core/tact-research/*にrecordDecision呼び出しなしを確認済み)、
      // fakeな成功を返さず明示的にエラーとする。
      void decision;

      throw new Error(
        "SupabaseCoreCapability: recordDecision() is not implemented yet " +
        "(no persistence table exists for Decision, STEP208)."
      );

    },

    async recordExecution(
      execution: Omit<CoreExecution, "id" | "createdAt">
    ): Promise<CoreExecution> {

      // STEP208-P: core/tact-research/runResearch.tsが全分岐で呼ぶため、
      // ここでthrowするとRegressionを引き起こす。CoreExecution用の
      // 永続化テーブルは今回のmigration対象外であり、新規テーブル作成・
      // tact_execution_historyの流用はいずれも禁止されているため、
      // 「未永続化」として扱い、interface契約(Promise<CoreExecution>)
      // を満たす値だけを返す(mockCoreCapability.tsのid/createdAt生成
      // 方式と同じ形)。
      return {
        ...execution,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

    },

  };

}
