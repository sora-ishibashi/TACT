// =========================
// mockCoreCapability (STEP175)
// =========================
//
// core/tact-core/types.tsのCoreCapability interfaceが「型として成立
// するか」「実装可能な形か」を確認するための、プロセス内メモリのみで
// 動く最小限の参照実装。既存のcomponents/design/mockDesignAgent.ts・
// mockAssetLibrary.ts(STEP43〜140、実LLM/実APIへ接続する前段階の
// モック)と同じ位置づけであり、命名規則もそれに揃えた。
//
// 重要: これは本番実装ではない。DB接続を一切持たず、プロセスを
// 再起動すると内容は消える。Supabase等への実接続はSTEP175の
// スコープ外(絶対条件9)。既存のcore/brain/history.ts・
// core/brain/memory.tsが辿った「まずプロセス内配列→後でSupabase化」
// という既存の移行パターンをここでも踏襲できる設計にしている。

import { randomUUID } from "crypto";
import {
  CoreCapability,
  LoadContextParams,
  RetrieveMemoryParams,
  RetrieveKnowledgeParams,
  RetrieveExamplesParams,
  Decision,
} from "./types";
import { CoreContext } from "./context/types";
import { CoreMemory } from "./memory/types";
import { KnowledgeItem, Example } from "./knowledge/types";
import { CoreExecution } from "./execution/types";

export function createMockCoreCapability(): CoreCapability {

  const memories: CoreMemory[] = [];
  const knowledgeItems: KnowledgeItem[] = [];
  const examples: Example[] = [];
  const decisions: Decision[] = [];
  const executions: CoreExecution[] = [];

  // STEP175: scopeでの絞り込みだけを行う、最小限のマッチング。
  // userId/organizationId/projectId/conversationIdはCoreMemory等の
  // 型自体には現れない(scopeという抽象値のみを持つ)ため、
  // ここでは「paramsが指定されたら対応するscopeのみへ絞る」という
  // 単純な近似に留める(厳密なentity単位の絞り込みは、実データ構造が
  // 固まる将来STEPで再設計する)。
  function matchesScopeParams(
    scope: string,
    params: LoadContextParams
  ): boolean {

    if (params.conversationId && scope === "conversation") return true;
    if (params.projectId && scope === "project") return true;
    if (params.organizationId && scope === "organization") return true;
    if (params.userId && scope === "user") return true;

    // どのIDも指定されていない場合は絞り込まない(全件対象)。
    return (
      !params.userId &&
      !params.organizationId &&
      !params.projectId &&
      !params.conversationId
    );

  }

  // STEP177: 「簡易keyword relevance」検索。Embedding/Vector検索は
  // 実装しない(STEP177-B絶対条件)。queryを空白区切りのtoken列へ
  // 分解し、searchableText内に含まれるtoken数を関連度スコアとする
  // (0件マッチは除外、マッチ数が多いほど上位)。日本語は空白を含まない
  // ことが多いため、query全体を1tokenとして扱うケースも自然にカバーする
  // (分割結果が1要素になるだけ)。
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

  // scope/kind等の既存フィルタを通過した配列に対し、query指定時は
  // 関連度でフィルタ・降順ソートし、limit指定時は件数を切り詰める、
  // という共通の後処理。retrieveKnowledge/retrieveExamplesの両方から
  // 使う(STEP177の「新しい抽象化を増やしすぎない」方針に沿い、
  // 汎用ヘルパーを1つだけ増やす)。
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

  return {

    async loadContext(
      params: LoadContextParams
    ): Promise<CoreContext> {

      return {

        conversationId: params.conversationId,

        memories: memories.filter((m) =>
          matchesScopeParams(m.scope, params)
        ),

        knowledge: knowledgeItems.filter((k) =>
          matchesScopeParams(k.scope, params)
        ),

        examples: examples.filter((e) =>
          matchesScopeParams(e.scope, params)
        ),

        recentExecutions: executions.filter((ex) =>
          matchesScopeParams(ex.scope, params)
        ),

      };

    },

    async retrieveMemory(
      params: RetrieveMemoryParams
    ): Promise<CoreMemory[]> {

      const filtered = memories.filter(
        (m) =>
          matchesScopeParams(m.scope, params) &&
          (!params.type || m.type === params.type)
      );

      // Phase 4(TACT Orchestrator): supabaseCoreCapability.tsの
      // retrieveMemory()と検索意味論を揃える(STEP208の「mock/
      // Persistent間で検索意味論を食い違わせない」方針を維持)。
      // params.query省略時は既存挙動(絞り込みなし+limitのみ)のまま。
      return applyQueryAndLimit(
        filtered,
        (item) => `${item.type} ${item.content} ${item.source ?? ""}`,
        params.query,
        params.limit
      );

    },

    async retrieveKnowledge(
      params: RetrieveKnowledgeParams
    ): Promise<KnowledgeItem[]> {

      const filtered = knowledgeItems.filter(
        (k) =>
          matchesScopeParams(k.scope, params) &&
          (!params.kind || k.kind === params.kind)
      );

      return applyQueryAndLimit(
        filtered,
        (k) => `${k.title} ${k.description ?? ""} ${k.content} ${k.tags.join(" ")}`,
        params.query,
        params.limit
      );

    },

    async retrieveExamples(
      params: RetrieveExamplesParams
    ): Promise<Example[]> {

      const filtered = examples.filter(
        (e) =>
          matchesScopeParams(e.scope, params) &&
          (!params.tags ||
            params.tags.some((tag) => e.tags.includes(tag)))
      );

      return applyQueryAndLimit(
        filtered,
        (e) => `${e.title} ${e.description ?? ""} ${e.reason ?? ""} ${e.category ?? ""} ${e.tags.join(" ")}`,
        params.query,
        params.limit
      );

    },

    async recordMemory(
      memory
    ): Promise<CoreMemory> {

      const record: CoreMemory = {
        ...memory,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      memories.push(record);

      return record;

    },

    async recordKnowledge(
      knowledge
    ): Promise<KnowledgeItem> {

      const timestamp = new Date().toISOString();

      const record: KnowledgeItem = {
        ...knowledge,
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      knowledgeItems.push(record);

      return record;

    },

    async recordExample(
      example
    ): Promise<Example> {

      const record: Example = {
        ...example,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

      examples.push(record);

      return record;

    },

    async recordDecision(
      decision
    ): Promise<Decision> {

      const record: Decision = {
        ...decision,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

      decisions.push(record);

      return record;

    },

    async recordExecution(
      execution
    ): Promise<CoreExecution> {

      const record: CoreExecution = {
        ...execution,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

      executions.push(record);

      return record;

    },

  };

}
