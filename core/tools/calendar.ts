import { Tool } from "./types";

export const calendar: Tool = {

  id: "calendar",

  description:
    "Read today's schedule from Google Calendar.",


  parameters: {

    type: "object",

    properties: {},

  },


  async execute(
    input: Record<string, unknown>
  ) {

    return {

      success: true,

      data: [

        {
          title: "Software Engineering",
          time: "10:30"
        },

        {
          title: "Baseball Practice",
          time: "18:00"
        }

      ]

    };

  }

};