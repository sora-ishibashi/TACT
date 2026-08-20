// =========================
// searchWithFallback (STEP151-F)
// =========================
//
// Provider横断のフォールバック実行を1箇所に集約する。
// core/tools/webSearch.tsはこの関数を呼ぶだけで、Tavily/Braveの
// 個別実装を一切知らない(「Provider固有ロジックをResearcherに
// 直接書かない」というSTEP151のルールを、Tool層でも徹底する)。
//
// フォールバック条件: 例外が投げられた場合だけでなく、Providerが
// 正常応答しても0件だった場合も次のProviderへ進む
// (「すべての失敗を無条件にBraveへ流すのではなく、検索結果が
// 得られなかった場合にフォールバックする」という要件どおり)。
//
// 可観測性: 各Providerの失敗をconsole.warnへ出す。provider名・
// query・失敗理由(reason)は出すが、API Keyは一切出力しない
// (各Provider実装(tavilyProvider.ts/braveProvider.ts)側で
// エラーメッセージにAPI Keyを含めないことを既に保証しているため、
// ここではそのメッセージをそのまま出すだけでよい)。

import {
  SearchProviderError,
  SearchProviderFailureReason,
  SearchProviderId,
  SearchRequest,
  SearchResult,
} from "./types";
import {
  getSearchProvider,
  getSearchProviderFallbackOrder,
} from "./registry";

export interface SearchProviderAttempt {

  provider: SearchProviderId;

  ok: boolean;

  reason?: SearchProviderFailureReason;

  message?: string;

}

export interface SearchWithFallbackResult {

  results: SearchResult[];

  // 実際に結果を返したProvider。全滅した場合はnull。
  provider: SearchProviderId | null;

  attempts: SearchProviderAttempt[];

}

export async function searchWithFallback(
  request: SearchRequest
): Promise<SearchWithFallbackResult> {

  const order = getSearchProviderFallbackOrder();

  const attempts: SearchProviderAttempt[] = [];

  for (const providerId of order) {

    const provider = getSearchProvider(providerId);

    if (!provider.isAvailable()) {

      attempts.push({
        provider: providerId,
        ok: false,
        reason: "unavailable",
        message: `${providerId} is not configured (missing API key).`,
      });

      console.warn(
        `[SearchProvider] ${providerId} unavailable (not configured). query="${request.query}"`
      );

      continue;

    }

    try {

      const results = await provider.search(request);

      if (results.length === 0) {

        attempts.push({
          provider: providerId,
          ok: false,
          reason: "empty_results",
          message: "0 results returned.",
        });

        console.warn(
          `[SearchProvider] ${providerId} returned 0 results. ` +
          `query="${request.query}" (falling back to next provider if available)`
        );

        continue;

      }

      attempts.push({
        provider: providerId,
        ok: true,
      });

      return {
        results,
        provider: providerId,
        attempts,
      };

    } catch (error) {

      const reason: SearchProviderFailureReason =
        error instanceof SearchProviderError
          ? error.reason
          : "unknown_error";

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      attempts.push({
        provider: providerId,
        ok: false,
        reason,
        message,
      });

      console.warn(
        `[SearchProvider] ${providerId} failed: reason=${reason} ` +
        `query="${request.query}" message=${message}`
      );

    }

  }

  // 全Providerが失敗、または全て0件だった場合。
  return {
    results: [],
    provider: null,
    attempts,
  };

}
