// =========================
// BraveProvider (STEP151)
// =========================
//
// Brave Search API(Web Search API)をSearchProviderとして実装する。
// 新しいnpm依存は追加せず、Node.js標準のfetch()のみを使う。
//
// API仕様(https://api.search.brave.com/res/v1/web/search):
//   GET ?q=<query>&count=<n>
//   Header: X-Subscription-Token: <API Key>
//   Response: { web: { results: [{ title, url, description, ... }] } }
//
// 重要: BraveのレスポンスをそのままEvidenceとして扱わない。
// core/tools/pipeline/normalize.ts(normalizeResult())が既に
// title/content/url/scoreという形を期待しているため、ここでは
// その形へ変換するところまでを担当する(Evidence化自体は既存の
// core/tools/pipeline/evidence.tsに委ねる。変更しない)。
//
// API Keyはログへ出力しない(request URLにもクエリパラメータとしては
// 含めず、ヘッダーのみで送る。エラーメッセージにも含めない)。

import {
  SearchProvider,
  SearchProviderError,
  SearchProviderFailureReason,
  SearchRequest,
  SearchResult,
} from "./types";

const BRAVE_SEARCH_ENDPOINT =
  "https://api.search.brave.com/res/v1/web/search";

const DEFAULT_MAX_RESULTS = 8;

const REQUEST_TIMEOUT_MS = 15_000;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

function classifyHttpFailure(
  status: number
): SearchProviderFailureReason {

  if (status === 401 || status === 403) {
    return "authentication_failed";
  }

  if (status === 429) {
    return "quota_exceeded";
  }

  if (status >= 500) {
    return "network_error";
  }

  return "unknown_error";

}

class BraveProvider implements SearchProvider {

  readonly id = "brave" as const;

  isAvailable(): boolean {

    return !!process.env.BRAVE_SEARCH_API_KEY;

  }

  async search(
    request: SearchRequest
  ): Promise<SearchResult[]> {

    if (!this.isAvailable()) {

      throw new SearchProviderError(
        this.id,
        "unavailable",
        "BRAVE_SEARCH_API_KEY is not configured."
      );

    }

    console.log("");
    console.log("====================================");
    console.log("BRAVE SEARCH");
    console.log(request.query);
    console.log("====================================");

    const url = new URL(BRAVE_SEARCH_ENDPOINT);

    url.searchParams.set("q", request.query);

    url.searchParams.set(
      "count",
      String(request.maxResults ?? DEFAULT_MAX_RESULTS)
    );

    const controller = new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
      );

    let response: Response;

    try {

      response =
        await fetch(url, {

          headers: {

            Accept: "application/json",

            // STEP151: API Keyはヘッダーのみで送る(URL・ログには含めない)。
            "X-Subscription-Token":
              process.env.BRAVE_SEARCH_API_KEY!,

          },

          signal: controller.signal,

        });

    } catch (error) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      // fetch()自体の失敗(タイムアウト・DNS解決失敗・接続拒否等)は
      // 全てnetwork_error扱いとする(HTTPステータスを伴わないため、
      // classifyHttpFailure()の対象外)。
      throw new SearchProviderError(
        this.id,
        "network_error",
        message
      );

    } finally {

      clearTimeout(timeout);

    }

    if (!response.ok) {

      // レスポンスボディにAPI Key等の秘密情報が含まれることは
      // Brave API仕様上ないため、エラーメッセージへ含めても安全
      // (リクエスト側に付与したヘッダー値そのものはここに現れない)。
      let bodyText = "";

      try {
        bodyText = (await response.text()).slice(0, 300);
      } catch {
        // ボディ読み取り自体に失敗しても、status文言だけで報告する。
      }

      throw new SearchProviderError(
        this.id,
        classifyHttpFailure(response.status),
        `Brave Search API returned ${response.status} ${response.statusText}` +
          (bodyText ? `: ${bodyText}` : "")
      );

    }

    let json: BraveSearchResponse;

    try {

      json = (await response.json()) as BraveSearchResponse;

    } catch (error) {

      throw new SearchProviderError(
        this.id,
        "unknown_error",
        `Failed to parse Brave Search API response: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

    }

    const results = json.web?.results ?? [];

    return results

      .filter(
        (item) =>
          typeof item.url === "string" &&
          typeof item.title === "string"
      )

      .map((item, index) => ({

        title: item.title!,

        url: item.url!,

        content: item.description ?? "",

        // STEP151: Brave Search APIは Tavily の score のような
        // 関連度スコアを返さないため、順位に基づく単純な減衰値を
        // 合成する(0.9 → 0.05刻みで減衰、最低0.1)。
        // normalizeResult()側はこのscoreを任意値として扱うのみで、
        // 既存のconvertConfidence()の閾値判定を壊さない範囲。
        score:
          Math.max(0.1, 0.9 - index * 0.05),

      }));

  }

}

export const braveProvider: SearchProvider = new BraveProvider();
