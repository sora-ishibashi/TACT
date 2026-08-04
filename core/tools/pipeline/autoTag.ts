import { Evidence } from "@/core/context/types";

const dictionary: Record<string, string[]> = {

  automotive: [
    "toyota",
    "honda",
    "nissan",
    "mazda",
    "subaru",
    "lexus",
    "ev",
    "battery",
    "車",
    "自動車",
    "電池",
  ],

  ai: [
    "ai",
    "gpt",
    "llm",
    "claude",
    "gemini",
    "openai",
    "生成ai",
    "人工知能",
  ],

  finance: [
    "revenue",
    "profit",
    "market",
    "stock",
    "売上",
    "利益",
    "株価",
    "市場",
  ],

  programming: [
    "typescript",
    "javascript",
    "react",
    "next.js",
    "api",
    "supabase",
  ],

};

export function autoTag(
  evidence: Evidence
): Evidence {

  const text = `
${evidence.claim}
${evidence.evidence}
`
    .toLowerCase();

  const tags: string[] = [];

  for (const [tag, words] of Object.entries(dictionary)) {

    if (

      words.some(
        word =>
          text.includes(
            word.toLowerCase()
          )
      )

    ) {

      tags.push(tag);

    }

  }

  return {

    ...evidence,

    tags,

  };

}