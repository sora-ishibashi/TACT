import { Tool } from "./types";

export const github: Tool = {

  id: "github",

  description: "Search GitHub repositories.",


  parameters: {

    type: "object",

    properties: {

      query: {

        type: "string",

        description: "GitHub search query",

      },

    },

    required: ["query"],

  },


  async execute(
    input: Record<string, unknown>
  ) {

    try {

      const query =
        String(input.query ?? "");


      const response =
        await fetch(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`
        );


      const json =
        await response.json();


      return {

        success: true,

        data: json.items.map((repo: any) => ({

          name: repo.full_name,

          description: repo.description,

          stars: repo.stargazers_count,

          url: repo.html_url,

        })),

      };


    } catch (error) {

      return {

        success: false,

        error: String(error),

      };

    }

  },

};