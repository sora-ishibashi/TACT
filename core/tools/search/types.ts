// =========================
// Search Provider Abstraction (STEP151)
// =========================
//
// 目的: TACTの検索経路をTavily単体依存から脱却させ、複数の
// Search Providerを交換・フォールバック可能にする。
// core/codeAgent/adapterRegistry.ts(STEP144、CodingAgentAdapterの
// 交換点)と同じ思想を検索Toolへ適用する。
//
// 重要: SearchResult型は新規に作らず、既存のcore/search/types.ts
// (STEP151着手前から存在していた、Tavily向けの未接続コード)の
// SearchResultをそのまま再利用する。title/url/content/scoreという
// 既存のcore/tools/pipeline/normalize.ts(normalizeResult())が
// 期待する形とも一致しているため、Evidence Builder側は一切
// 変更しなくて済む。
//
// 一方でSearchProvider自体(query: stringだけを受け取る形)は、
// Provider識別子(id)・オプション(maxResults)・失敗理由の分類を
// 保持できないため、ここで拡張したインターフェースを新設する
// (既存のcore/search/index.ts・evidenceParser.ts・
// providers/tavily.tsは今回のSTEPの対象外の未接続コードのため、
// 一切変更しない)。

import type { SearchResult } from "@/core/search/types";

export type { SearchResult };

export type SearchProviderId = "tavily" | "brave";

export interface SearchRequest {

  query: string;

  // 省略時は各Provider実装側のデフォルト値を使う。
  maxResults?: number;

  // STEP158: Search Strategy(core/tools/search/searchStrategy.ts)が
  // TaskProfile.searchIntensityから解決する検索深度。Tavilyのみが
  // 対応するパラメータで、Brave Search APIには深度の概念が存在しない
  // ため、BraveProviderはこのフィールドを単に無視する(型エラーには
  // ならない。SearchProviderインターフェース自体は変更していない)。
  // 省略時は各Provider実装側の既存デフォルト値を使う。
  searchDepth?: "basic" | "advanced";

}

// Providerの失敗理由。executeToolCalls()側のログ・フォールバック判定
// (core/tools/search/searchWithFallback.ts)で使う。
export type SearchProviderFailureReason =
  | "quota_exceeded"
  | "authentication_failed"
  | "network_error"
  | "empty_results"
  | "unavailable"
  | "unknown_error";

// Provider固有の例外を、Provider横断で扱える形に正規化するための
// Error。API Keyそのものは絶対にmessageへ含めない(各Provider実装側の
// 責務)。
export class SearchProviderError extends Error {

  readonly provider: SearchProviderId;

  readonly reason: SearchProviderFailureReason;

  constructor(
    provider: SearchProviderId,
    reason: SearchProviderFailureReason,
    message: string
  ) {

    super(message);

    this.provider = provider;

    this.reason = reason;

    this.name = "SearchProviderError";

  }

}

export interface SearchProvider {

  readonly id: SearchProviderId;

  // 実行環境でこのProviderが呼び出し可能かを、副作用なしで確認する
  // (core/codeAgent/types.tsのCodingAgentAdapter.isAvailable()と
  // 同じ思想)。API Keyが未設定の場合など。
  isAvailable(): boolean;

  // 失敗時は例外を投げず、必ずSearchProviderErrorを投げること
  // (呼び出し元のsearchWithFallback()がProvider横断で失敗理由を
  // 判別するため)。
  search(
    request: SearchRequest
  ): Promise<SearchResult[]>;

}
