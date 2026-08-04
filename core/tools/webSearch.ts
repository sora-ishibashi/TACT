import { tavily } from "@tavily/core";
import { Tool } from "./types";

const client = tavily({
  apiKey: process.env.TAVILY_API_KEY!,
});

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

    const isLatest =
      /最新|今日|今週|news|News|today|current/i.test(query);

    console.log("");
    console.log("====================================");
    console.log("WEB SEARCH");
    console.log(query);
    console.log(
      "Search Topic:",
      isLatest ? "news" : "general"
    );
    console.log("====================================");

    const result =
      await client.search(query, {

        searchDepth: "advanced",

        maxResults: 8,

        includeRawContent: "text",

        topic:
          isLatest
            ? "news"
            : "general",

      });

    return {

      success: true,

      data: result.results,

    };

  },

};