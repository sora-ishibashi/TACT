import { tavily } from "@tavily/core";
import { SearchResult } from "../types";

const client = tavily({
  apiKey: process.env.TAVILY_API_KEY!,
});

export async function tavilySearch(
  query: string
): Promise<SearchResult[]> {

  console.log("");
  console.log("====================================");
  console.log("TAVILY SEARCH");
  console.log(query);
  console.log("====================================");

  const result =
    await client.search(query, {

      searchDepth: "advanced",

      maxResults: 8,

      includeRawContent: "text",

      topic: "general",

    });

  return result.results.map((item) => ({

    title: item.title,

    url: item.url,

    content:
      item.rawContent ??
      item.content ??
      "",

    score:
      item.score ?? 0,

  }));

}