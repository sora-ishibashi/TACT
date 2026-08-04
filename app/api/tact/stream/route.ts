import { NextRequest } from "next/server";

import { runWorkflow } from "@/core/workflow";
import { defaultWorkflow } from "@/core/workflow/defaultWorkflow";

export async function GET(
  request: NextRequest
) {

  const encoder = new TextEncoder();

  const { searchParams } =
    new URL(request.url);

  const input =
    searchParams.get("input") ?? "";

  const mode =
    (searchParams.get("mode") ??
      "think") as
      | "quick"
      | "think"
      | "deep";

  const stream =
    new ReadableStream({

      async start(controller) {

        // 接続完了
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "connected",
            })}\n\n`
          )
        );

        try {

          const context =
            await runWorkflow(
              defaultWorkflow,
              input,
              mode,

              (event) => {

                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify(
                      event
                    )}\n\n`
                  )
                );

              }
            );

          // 最終成果物
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "result",
                result:
                  context.outputs.writer,
              })}\n\n`
            )
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "finished",
              })}\n\n`
            )
          );

        } catch (error) {

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: String(error),
              })}\n\n`
            )
          );

        }

        controller.close();

      },

    });

  return new Response(stream, {

    headers: {

      "Content-Type":
        "text/event-stream",

      "Cache-Control":
        "no-cache",

      Connection:
        "keep-alive",

    },

  });

}