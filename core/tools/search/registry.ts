// =========================
// Search Provider Registry (STEP151)
// =========================
//
// core/codeAgent/adapterRegistry.ts(STEP144、CodingAgentAdapterの
// 交換点)と同じ思想。Provider生成をここへ一箇所に集約し、Researcher・
// core/tools/webSearch.ts側はProvider固有の実装を意識しない。
//
// 将来Exa/Google/Bing等を追加する場合、SearchProviderIdへ値を
// 追加し、ここへcaseを1つ足すだけで済む(今回は追加しない)。

import { SearchProvider, SearchProviderId } from "./types";
import { tavilyProvider } from "./tavilyProvider";
import { braveProvider } from "./braveProvider";

export function getSearchProvider(
  id: SearchProviderId
): SearchProvider {

  switch (id) {

    case "tavily":
      return tavilyProvider;

    case "brave":
      return braveProvider;

    default: {

      // TypeScriptのexhaustive checkのため。SearchProviderIdに
      // 新しい値を追加した場合、ここでコンパイルエラーになる
      // (対応するProviderの実装漏れを防ぐ)。
      const _exhaustiveCheck: never = id;
      throw new Error(`Unknown SearchProviderId: ${_exhaustiveCheck}`);

    }

  }

}

// =========================
// Provider選択(STEP151-G)
// =========================
//
// 初期仕様: Primary=Tavily, Fallback=Brave という単純な固定順序。
// 「Research typeに応じたProvider選択」等の高度なルーティングは
// 今回実装しない(将来この関数の中身だけを差し替えれば拡張できる
// 余地として残す)。

export function getSearchProviderFallbackOrder(): SearchProviderId[] {

  return ["tavily", "brave"];

}
