import { NextRequest, NextResponse } from "next/server";

import { runChat } from "@/core/tact-intent/chatHandler";

// =========================
// POST /api/tact/chat (STEP216)
// =========================
//
// Intent Routerが"chat"と判定した入力専用の、新規の最小API。
// app/api/tact/research/route.ts・app/api/tact/core/push/route.tsと
// 同じ構造(HTTP入力の受け取り・最低限のvalidation・1回のHandler呼び出し
// ・結果のレスポンス変換・例外のAPIレベルエラーへの変換だけを行う)を
// 踏襲する。
//
// 重要: このRouteはcore/tact-intent/chatHandler.ts経由でrunLLM()を
// 直接呼ぶだけであり、core/conversation/runConversationTurn()・
// core/workflow/runWorkflow()・core/agents配下のいずれにも依存しない
// (STEP216絶対条件)。
//
// 認証(STEP216): 既存/api/tact/research/route.tsと同じ方針で、
// 未認証でも拒否しない(chatはUser Scopeを必要としないため)。
//
// body:
// {
//   input: string
// }
//
// response:
// {
//   success: true,
//   response: string
// }

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const input = body.input;

    if (
      !input ||
      typeof input !== "string" ||
      !input.trim()
    ) {

      return NextResponse.json(
        {
          success: false,
          error: "input is required and must be a non-empty string",
        },
        { status: 400 }
      );

    }

    const response = await runChat(input);

    return NextResponse.json({
      success: true,
      response,
    });

  } catch (error) {

    console.error(
      "TACT Chat API failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: String(error),
      },
      { status: 500 }
    );

  }

}
