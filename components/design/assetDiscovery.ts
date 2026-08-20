// =========================
// assetDiscovery (STEP140)
// =========================
//
// 「既存Assetを検索する」最小ロジック。高度なEmbedding検索は
// 実装せず、まずtitle/tags/extractedText/typeに対する素朴な
// keyword matchingだけで成立させる(将来、実際のCanva Connect API/
// Microsoft Graph APIに接続した際、この検索ロジックの入力元
// (mockAssets)だけを差し替えられるようにしておく)。
//
// 最重要原則: 該当する既存Assetが見つからない場合、絶対に
// 新しい素材を生成して補完しない。「見つからなかった」という
// 結果をそのまま返す。

import {
  AssetReference,
  AssetType,
  DocumentElementType,
} from "./types";

// =========================
// AssetSearchQuery / AssetSearchResult
// =========================

export interface AssetSearchQuery {
  // 「名古屋の店舗写真が必要」のような、必要な素材の自然文説明。
  description: string;

  // 既知であれば絞り込みに使う(未指定の場合は全typeを対象にする)。
  type?: AssetType;
}

export interface AssetSearchResult {
  asset: AssetReference;

  // マッチしたキーワード数などから算出する単純なスコア(相対値)。
  score: number;

  matchedFields: string[];
}

// =========================
// searchAssets
// =========================
//
// 日本語は単語間に空白が無いため、クエリ自体を空白区切りで
// 「単語」に分割するアプローチ(英語的なtokenize)は機能しない
// (例:「既存のロゴを配置して」は区切り文字を含まず1トークンに
// なってしまう)。そのため、クエリを分割するのではなく、
// 各Assetが持つ既知の語彙(tags/type、いずれも短い既知語)が
// クエリ文字列に部分一致するかどうかを直接調べる方式にする。
//
// 安全側の設計(STEP140-G): 「写真」「画像」のような一般的すぎる
// 単一タグの一致だけでは採用しない。無関係な問い合わせ
// (例:「火星の風景写真」)が、たまたま1つの一般的なタグ
// (「写真」)とだけ一致して無関係なAssetを誤って候補にしてしまう
// ことを防ぐため、最低2つの異なるシグナル(タグ2件以上、または
// タグ1件+type一致等)が一致した場合のみ候補とする。

const MIN_MATCHED_SIGNALS = 2;

export function searchAssets(
  query: AssetSearchQuery,
  library: AssetReference[]
): AssetSearchResult[] {

  const description = query.description;

  if (!description) return [];

  const results: AssetSearchResult[] = [];

  for (const asset of library) {

    if (query.type && asset.type !== query.type) continue;

    const matchedFields = new Set<string>();

    let score = 0;
    let signalCount = 0;

    const tags = asset.metadata?.tags ?? [];

    // タグは既知の短い語彙のため、クエリ文字列への部分一致で
    // 直接判定できる(クエリ側を分割する必要がない)。
    const matchedTags = tags.filter(
      (tag) => tag.length >= 2 && description.includes(tag)
    );

    if (matchedTags.length > 0) {
      score += matchedTags.length * 2;
      signalCount += matchedTags.length;
      matchedFields.add("tags");
    }

    // type(image/logo/chart等)がクエリに含まれる場合も1シグナル。
    if (description.includes(asset.type)) {
      score += 1;
      signalCount += 1;
      matchedFields.add("type");
    }

    // タイトルは複合語(例:「東京本店 外観写真」)であることが多く、
    // クエリに丸ごと含まれることは稀なため、タグほど強くは
    // 重み付けしない(補助シグナル)。タイトル自体が短い語として
    // クエリに部分一致する場合のみ加点する。
    const title = asset.metadata?.title ?? "";
    if (title.length >= 2 && description.includes(title)) {
      score += 2;
      signalCount += 1;
      matchedFields.add("title");
    }

    if (signalCount < MIN_MATCHED_SIGNALS) continue;

    results.push({
      asset,
      score,
      matchedFields: Array.from(matchedFields),
    });

  }

  return results.sort((a, b) => b.score - a.score);

}

// =========================
// resolveAssetNeed
// =========================
//
// searchAssets()の結果から、実際に採用するAssetを1件だけ決める。
// スコアが閾値未満、または候補が0件の場合は"not_found"を返す
// (=無理に最有力候補を採用しない。安全側に倒す)。

export type AssetResolution =
  | { status: "found"; asset: AssetReference; score: number }
  | { status: "not_found"; reason: string };

const MIN_SCORE_THRESHOLD = 2;

export function resolveAssetNeed(
  query: AssetSearchQuery,
  library: AssetReference[]
): AssetResolution {

  const results = searchAssets(query, library);

  const best = results[0];

  if (!best || best.score < MIN_SCORE_THRESHOLD) {

    return {
      status: "not_found",
      reason:
        `「${query.description}」に該当する既存素材が` +
        "見つかりませんでした。",
    };

  }

  return {
    status: "found",
    asset: best.asset,
    score: best.score,
  };

}

// =========================
// identifyAssetNeedsFromOutput
// =========================
//
// TACT CoreのWriter出力(currentOutput)を読み、「この節にはどんな
// 既存素材が必要そうか」を素朴なキーワード検出だけで洗い出す。
// LLMは使わない(mockDesignAgent.tsの既存方針と同じ、将来実LLMへ
// 差し替える前提のMock実装)。Core側のWriter出力Schema
// (core/prompt/outputFormats.ts)は変更せず、あくまで既存フィールド
// (title/sections[].heading/sections[].content)を読み取るだけ。

const ASSET_HINT_KEYWORDS: { keyword: string; type?: AssetType }[] = [
  { keyword: "写真", type: "image" },
  { keyword: "画像", type: "image" },
  { keyword: "ロゴ", type: "logo" },
  { keyword: "グラフ", type: "chart" },
  { keyword: "図表", type: "chart" },
  { keyword: "アイコン", type: "icon" },
  { keyword: "図解", type: "shape" },
];

interface SourceSectionForNeeds {
  heading?: unknown;
  content?: unknown;
}

interface SourceOutputForNeeds {
  title?: unknown;
  sections?: unknown;
}

export function identifyAssetNeedsFromOutput(
  currentOutput: unknown
): AssetSearchQuery[] {

  const output = currentOutput as SourceOutputForNeeds | null | undefined;

  if (!output || typeof output !== "object") return [];

  const sections = Array.isArray(output.sections)
    ? (output.sections as SourceSectionForNeeds[])
    : [];

  const queries: AssetSearchQuery[] = [];

  for (const section of sections) {

    const heading =
      typeof section.heading === "string" ? section.heading : "";

    const content =
      typeof section.content === "string" ? section.content : "";

    const combinedText = `${heading} ${content}`;

    for (const hint of ASSET_HINT_KEYWORDS) {

      if (combinedText.includes(hint.keyword)) {

        queries.push({
          description: heading || hint.keyword,
          type: hint.type,
        });

        // 1節につき、同じ節から複数回同じ種類の素材要求は出さない。
        break;

      }

    }

  }

  return queries;

}

// =========================
// deriveAssetSuggestions
// =========================
//
// identifyAssetNeedsFromOutput() → resolveAssetNeed() を1回で
// まとめて実行し、「見つかったもの」と「見つからなかったもの」を
// 分けて返す。見つからなかったものは、生成で補完せず
// unresolvedとしてそのまま返す(呼び出し側がユーザーへ
// 「素材が見つかりませんでした」と伝えるために使う)。

export interface ResolvedAssetSuggestion {
  query: AssetSearchQuery;
  asset: AssetReference;
  score: number;
}

export interface UnresolvedAssetNeed {
  query: AssetSearchQuery;
  reason: string;
}

export interface AssetSuggestions {
  resolved: ResolvedAssetSuggestion[];
  unresolved: UnresolvedAssetNeed[];
}

export function deriveAssetSuggestions(
  currentOutput: unknown,
  library: AssetReference[]
): AssetSuggestions {

  const queries = identifyAssetNeedsFromOutput(currentOutput);

  const resolved: ResolvedAssetSuggestion[] = [];
  const unresolved: UnresolvedAssetNeed[] = [];

  for (const query of queries) {

    const resolution = resolveAssetNeed(query, library);

    if (resolution.status === "found") {

      resolved.push({
        query,
        asset: resolution.asset,
        score: resolution.score,
      });

    } else {

      unresolved.push({
        query,
        reason: resolution.reason,
      });

    }

  }

  return { resolved, unresolved };

}

// =========================
// assetTypeToElementType
// =========================
//
// AssetReference.typeを、既存のDocumentElementType(text/shape/
// table/image/group/list)へ対応づける。DocumentElementTypeは
// STEP140で新設していない(既存の型のまま)ため、AssetTypeの方を
// 既存の型へ丸める形にする。DocumentRenderer側の描画分岐は
// shape/image/groupをまとめて扱っているため、この対応づけの
// 粒度で現状問題ない。

export function assetTypeToElementType(
  assetType: AssetType
): DocumentElementType {

  switch (assetType) {

    case "image":
    case "chart":
      return "image";

    case "icon":
    case "shape":
      return "shape";

    case "logo":
      return "image";

    case "template":
    case "slide":
      return "group";

    default:
      return "image";

  }

}
