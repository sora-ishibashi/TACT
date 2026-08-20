import { Evidence } from "../context/types";

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compact(text: string) {
  return normalize(text).replace(/\s+/g, "");
}

function wordTokens(text: string) {
  return normalize(text)
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(text: string, size: number) {
  const source = compact(text);

  if (source.length < size) return [];

  const result: string[] = [];

  for (let i = 0; i <= source.length - size; i++) {
    result.push(source.slice(i, i + size));
  }

  return result;
}

function queryTokens(query: string) {
  const words = wordTokens(query);
  const grams2 = ngrams(query, 2);
  const grams3 = ngrams(query, 3);

  return Array.from(
    new Set([
      ...words,
      ...grams2,
      ...grams3,
    ])
  );
}

export function inferSourceType(source?: string) {

  if (!source) return "unknown";

  const s = source.toLowerCase();

  if (
    s.includes(".gov") ||
    s.includes(".go.jp") ||
    s.includes("mhlw.go.jp") ||
    s.includes("meti.go.jp") ||
    s.includes("cas.go.jp")
  ) {
    return "government";
  }

  if (
    s.includes("arxiv.org") ||
    s.includes("doi.org") ||
    s.includes("acm.org") ||
    s.includes("ieee.org") ||
    s.includes("nature.com") ||
    s.includes("science.org")
  ) {
    return "paper";
  }

  if (
    s.includes("openai.com") ||
    s.includes("anthropic.com") ||
    s.includes("google.com") ||
    s.includes("blog.google") ||
    s.includes("microsoft.com") ||
    s.includes("aws.amazon.com") ||
    s.includes("meta.com") ||
    s.includes("github.com") ||
    s.includes("docs.") ||
    s.includes("developer.") ||
    s.includes("support.")
  ) {
    return "official";
  }

  if (
    s.includes("reuters.com") ||
    s.includes("bloomberg.com") ||
    s.includes("wsj.com") ||
    s.includes("ft.com") ||
    s.includes("nytimes.com")
  ) {
    return "news";
  }

  return "unknown";
}

function sourceTypeWeight(type: string) {

  switch (type) {

    // STEP35: ユーザーが今回のために直接提供した一次資料
    // (core/fileAnalysis/buildAttachmentEvidence.tsが生成)。
    // 以前はdefaultの0点(=communityの10点より低い)しか付与されず、
    // Web由来Evidenceに比べて上位limit件から外れやすいという
    // 構造的な問題があった。ユーザーが今回のタスクのために
    // 選んで添付した資料であるため、government(55)より高く扱う。
    case "user_file":
      return 60;

    case "government":
      return 55;

    case "official":
      return 50;

    case "paper":
      return 45;

    case "news":
      return 35;

    case "media":
      return 20;

    case "community":
      return 10;

    default:
      return 0;

  }

}

function confidenceWeight(
  confidence: Evidence["confidence"]
) {

  switch (confidence) {

    case "high":
      return 30;

    case "medium":
      return 20;

    case "low":
      return 10;

    default:
      return 0;

  }

}

function freshnessWeight(
  publishedAt?: string
) {

  if (!publishedAt) return 0;

  const date = new Date(publishedAt);

  if (isNaN(date.getTime())) return 0;

  const now = new Date();

  const years =
    now.getFullYear() -
    date.getFullYear();

  if (years <= 0) return 20;

  if (years === 1) return 15;

  if (years === 2) return 10;

  if (years === 3) return 5;

  return 0;

}

function overlapScore(
  tokens: string[],
  text: string
) {

  const normalized = normalize(text);
  const compacted = compact(text);

  let score = 0;

  for (const token of tokens) {

    if (!token) continue;

    if (
      normalized.includes(token) ||
      compacted.includes(token)
    ) {

      score +=
        token.length >= 3
          ? 2
          : 1;

    }

  }

  return score;

}

export function retrieveEvidence(
  evidence: Evidence[],
  query: string,
  limit = 8
): Evidence[] {

  const tokens =
    queryTokens(query);

  return [...evidence]

    .map((item) => {

      const title =
        item.claim ?? "";

      const body =
        item.evidence ?? "";

const source =
  item.source ?? "";
  
const tags =
  Array.isArray(item.tags)
    ? item.tags.join(" ")
    : "";

      const combined =
        `${title} ${body} ${source} ${tags}`;

      const keywordScore =
        overlapScore(
          tokens,
          combined
        );

      const titleBonus =
        overlapScore(
          tokens,
          title
        ) * 2;

      const sourceType =
        item.sourceType ??
        inferSourceType(source);

      const score =

        keywordScore * 6 +

        titleBonus * 4 +

        sourceTypeWeight(
          sourceType
        ) +

        confidenceWeight(
          item.confidence
        ) +

        freshnessWeight(
          item.publishedAt
        ) +

        (item.score ?? 0);

      return {

        item,

        score,

      };

    })

    .sort(
      (a, b) =>
        b.score - a.score
    )

    .slice(0, limit)

    .map(
      (x) => x.item
    );

}