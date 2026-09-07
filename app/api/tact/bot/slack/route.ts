import { NextRequest, NextResponse } from "next/server";

import { handleSlackWebhookRequest } from "@/core/tact-bot/adapters/slack/handleSlackWebhookRequest";

// =========================
// POST /api/tact/bot/slack (S1a — Slack Interface Inbound Foundation)
// =========================
//
// Slack Events APIのwebhook配信先。この Route自体の責務は薄く保つ
// (絶対条件Section19): raw bodyを取得し、実処理は
// core/tact-bot/adapters/slack/handleSlackWebhookRequest.tsへ委譲する
// だけ——署名検証・event判定・dedup claim・canonicalization・
// receiveBotMessage()呼び出しのロジックはすべてそちら側にある
// (テスト容易性のため、DI可能な形をそちらに集約する)。
//
// runtime="nodejs"を明示する理由: 署名検証(node:crypto の
// createHmac/timingSafeEqual)およびNext.js after()(background
// execution)はNode.js runtimeを前提とする(Edge runtimeでは挙動が
// 異なる/利用できない可能性がある)。
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {

  try {

    // 絶対条件: JSON.parse前のraw bodyを署名検証に使う
    // (handleSlackWebhookRequest.ts側でJSON.parseする)。
    const rawBody = await request.text();

    const result = await handleSlackWebhookRequest(rawBody, request.headers);

    return NextResponse.json(result.body, { status: result.status });

  } catch (error) {

    // 絶対条件(Section18と同じfail closedの精神): 予期しない例外でも
    // 200を返して「処理済み」であるかのように見せない。
    console.error("[tact-bot] Slack webhook handling failed:", error);

    return NextResponse.json(
      { error: "internal_error" },
      { status: 500 }
    );

  }

}
