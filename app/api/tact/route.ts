import { NextRequest, NextResponse } from "next/server";

import { runWorkflow } from "@/core/workflow";
import { defaultWorkflow } from "@/core/workflow/defaultWorkflow";

export async function POST(
  request: NextRequest
) {
  try {

    const body = await request.json();

    // モードを取得（未指定ならthink）
    const mode =
      body.mode ?? "think";

    const context = await runWorkflow(
      defaultWorkflow,
      body.input,
      mode
    );

    return NextResponse.json({

      success: true,

      // Workflow
      workflow: {
        mode,
        status: context.agentStatus,
        logs: context.logs,
        events: context.events,
      },

      // 最終成果物
      result:
        context.outputs.writer ??
        null,

      // Agent成果物
      agentOutputs:
        context.outputs,

      // デバッグ用
      outputs:
        context.outputs,

      stepOutputs:
        context.stepOutputs,

      memory:
        context.memory,

      logs:
        context.logs,

      events:
        context.events,

    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: String(error),
      },
      {
        status: 500,
      }
    );

  }
}