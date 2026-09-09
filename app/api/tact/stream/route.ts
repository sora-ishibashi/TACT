import { NextRequest, NextResponse } from "next/server";

import { runWorkflow } from "@/core/workflow";
import { defaultWorkflow } from "@/core/workflow/defaultWorkflow";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// TACT SEC-P0-2(Pre-Live Remediation): 認証必須化。Pre-Live Full
// Repository Audit P0 finding #2参照(app/api/tact/route.tsと同じ
// 理由)。SSE streamを開始する前に検証し、認証失敗時はLegacy
// workflow engineへ一切到達させない。

export async function GET(
  request: NextRequest
) {

  const { userId } = await getCurrentUserContext(request);

  if (!userId) {

    return NextResponse.json(
      { success: false, error: "authentication required" },
      { status: 401 }
    );

  }

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