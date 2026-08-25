// =========================
// TavilyProvider (STEP151)
// =========================
//
// core/tools/webSearch.tsに直書きされていたTavily呼び出しを
// SearchProviderインターフェースへ適合させただけで、検索方法自体
// (searchDepth/maxResults/includeRawContent/topic判定)は一切
// 変更していない。

import { tavily } from "@tavily/core";
import {
  SearchProvider,
  SearchProviderError,
  SearchRequest,
  SearchResult,
} from "./types";

const DEFAULT_MAX_RESULTS = 8;

// Phase43: Tavilyが返すpublishedDateの表記揺れ(RFC2822形式等)を、
// Evidence.publishedAt(string、フォーマット規定なし)に対して既存の
// 消費者(core/evidence/scoreEvidence.ts・retrieveEvidence.tsの
// freshnessWeight()、いずれもnew Date(publishedAt)でパースする)が
// 一貫して扱えるよう、ISO 8601形式へ正規化する。パース不能・空文字列の
// 場合はundefinedを返し、無効な日時文字列を生成しない(絶対条件Rule12)。
function normalizePublishedDate(
  raw: string | undefined
): string | undefined {

  if (!raw) {
    return undefined;
  }

  const date = new Date(raw);

  if (isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();

}

function classifyTavilyError(
  error: unknown
): { reason: import("./types").SearchProviderFailureReason; message: string } {

  const message =
    error instanceof Error ? error.message : String(error);

  const lower = message.toLowerCase();

  if (
    lower.includes("usage limit") ||
    lower.includes("quota") ||
    lower.includes("plan")
  ) {
    return { reason: "quota_exceeded", message };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return { reason: "authentication_failed", message };
  }

  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("enotfound")
  ) {
    return { reason: "network_error", message };
  }

  return { reason: "unknown_error", message };

}

class TavilyProvider implements SearchProvider {

  readonly id = "tavily" as const;

  isAvailable(): boolean {

    return !!process.env.TAVILY_API_KEY;

  }

  async search(
    request: SearchRequest
  ): Promise<SearchResult[]> {

    if (!this.isAvailable()) {

      throw new SearchProviderError(
        this.id,
        "unavailable",
        "TAVILY_API_KEY is not configured."
      );

    }

    // STEP151: clientはAPI Key未設定時にsearch()を呼ばない限り
    // インスタンス化コスト以外の副作用を持たないため、isAvailable()
    // チェック後にここで生成する(モジュール読み込み時に無条件で
    // インスタンス化していた既存実装を、未設定環境でも安全に
    // importできる形へ変更しただけ)。
    const client = tavily({
      apiKey: process.env.TAVILY_API_KEY!,
    });

    const isLatest =
      /最新|今日|今週|news|News|today|current/i.test(
        request.query
      );

    console.log("");
    console.log("====================================");
    console.log("TAVILY SEARCH");
    console.log(request.query);
    console.log(
      "Search Topic:",
      isLatest ? "news" : "general"
    );
    console.log("====================================");

    let result;

    try {

      result = await client.search(request.query, {

        // STEP158: Search Strategyが解決したsearchDepthを使う。
        // 省略時(taskProfile未接続の呼び出し元等)は既存どおり"advanced"。
        searchDepth: request.searchDepth ?? "advanced",

        maxResults: request.maxResults ?? DEFAULT_MAX_RESULTS,

        includeRawContent: "text",

        topic:
          isLatest
            ? "news"
            : "general",

      });

    } catch (error) {

      const { reason, message } =
        classifyTavilyError(error);

      throw new SearchProviderError(
        this.id,
        reason,
        message
      );

    }

    return result.results.map((item) => ({

      title: item.title,

      url: item.url,

      content:
        item.rawContent ??
        item.content ??
        "",

      score:
        item.score ?? 0,

      // Phase43: Tavily SDKのTavilySearchResult.publishedDateは型上は
      // 必須文字列だが、実際には日時が不明な結果に対して空文字列を
      // 返すことがあるため、空文字列はundefined相当として扱う
      // (絶対条件Rule2: 推測しない)。取得できた場合のみ、既存Evidence型
      // (string)に合わせてISO 8601へ正規化する(絶対条件Rule6)。
      // パース不能な値だった場合も、無理に文字列化せずundefinedにする。
      publishedAt: normalizePublishedDate(item.publishedDate),

    }));

  }

}

export const tavilyProvider: SearchProvider = new TavilyProvider();
