import { Tool } from "./types";
import { searchWithFallback } from "./search/searchWithFallback";

// =========================
// web-search Tool (STEP151)
// =========================
//
// STEP151以前はTavily SDKをここで直接呼び出していたが、
// Tavily quota超過時にTACTのResearch経路全体が停止する問題
// (STEP149/150で確認)に対応するため、Provider抽象化
// (core/tools/search/)経由の呼び出しへ差し替えた。
//
// 重要: このファイルの外から見える契約(Tool.id="web-search"、
// execute()の入出力形)は一切変更していない。呼び出し元
// (core/tools/pipeline/executeToolPipeline.ts、Researcher等)は
// Providerが複数になったことを意識しない。

export const webSearch: Tool = {

  id: "web-search",

  description: "Search the web for recent information.",

  parameters: {

    type: "object",

    properties: {

      query: {

        type: "string",

        description: "Search query",

      },

    },

    required: ["query"],

  },

  async execute(
    input: Record<string, unknown>
  ) {

    const query =
      String(input.query ?? "").trim();

    if (!query) {

      return {

        success: false,

        error: "Search query is empty.",

      };

    }

    // STEP158: maxResults/searchDepthはLLMのtoolRequests引数ではなく、
    // 呼び出し元(core/tools/pipeline/executeToolPipeline.ts)が
    // Search Strategy(TaskProfile.searchIntensity由来)から解決して
    // inputへ注入する。Tool自身の parameters スキーマ(query必須のみ)
    // は変更していないため、LLM側がこれらの値を意識する必要はない。
    const maxResults =
      typeof input.maxResults === "number"
        ? input.maxResults
        : undefined;

    const searchDepth =
      input.searchDepth === "basic" ||
      input.searchDepth === "advanced"
        ? input.searchDepth
        : undefined;

    const { results, provider, attempts } =
      await searchWithFallback({ query, maxResults, searchDepth });

    if (results.length === 0) {

      // 全Providerが失敗、または0件だった場合。架空の結果を
      // 作らず、素直に失敗として返す(既存の安全設計を維持)。
      const failureSummary =
        attempts
          .map((a) => `${a.provider}:${a.reason ?? "ok"}`)
          .join(", ");

      return {

        success: false,

        error:
          `All search providers failed or returned no results (${failureSummary}).`,

      };

    }

    return {

      success: true,

      data: results,

      // STEP151-H: どのProviderが実際に結果を返したかを、
      // Evidence型自体は変更せずに保持しておくための追加情報
      // (core/tools/pipeline/executeToolPipeline.tsがdata.provider
      // として引き継ぐ。ログ・診断用途のみで、Evidence DBスキーマの
      // 変更は伴わない)。results.length > 0の時点でprovider は
      // 必ず非nullだが(searchWithFallback()の契約)、ToolResultの
      // provider型(string | undefined)に合わせてnullをundefinedへ
      // 変換する。
      provider: provider ?? undefined,

    };

  },

};
