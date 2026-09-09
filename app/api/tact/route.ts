import { NextRequest, NextResponse } from "next/server";

import { runWorkflow } from "@/core/workflow";
import { defaultWorkflow } from "@/core/workflow/defaultWorkflow";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// TACT SEC-P0-2(Pre-Live Remediation): 認証必須化。Pre-Live Full
// Repository Audit(docs/architecture/pre-live-full-audit.md)の
// P0 finding #2で、このrouteが認証なしでLegacy 9-Agent workflow
// engineを起動でき、LLM呼び出し・DB書き込みへ到達できることが
// 判明した。既存core/auth/getUserContext.tsの認証patternをそのまま
// 再利用する——Legacy workflow engine自体のarchitectureは変更しない。

export async function POST(
  request: NextRequest
) {
  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {

      return NextResponse.json(
        { success: false, error: "authentication required" },
        { status: 401 }
      );

    }

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