import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// =========================
// POST /api/tact/beta-feedback (STEP30)
// =========================
//
// βテストのフィードバックアンケート回答を保存するだけの、
// 最小限のエンドポイント。
//
// 既存のcore/workflow/runAgent.ts(saveAgentLog)や
// core/conversation/reconstructTask.ts(saveReconstructionLog)と
// 同じ「logs/配下にJSONとして書き出す」という既存の慣習をそのまま
// 踏襲する。新しいDBテーブル・新しいDB接続は一切追加しない。
//
// 認証機構が未導入のため、回答者を特定する情報は保存しない
// (必要であれば任意でconversationIdのみ関連情報として保存する)。
//
// body:
// {
//   satisfaction: number,       // 質問1(1-5)
//   usefulParts: string[],      // 質問2(複数選択)
//   difficulties: string,       // 質問3(自由記述)
//   willingnessToReuse: number, // 質問4(1-5)
//   wantedFeatures: string,     // 質問5(自由記述)
//   conversationId?: string,    // 送信時点のConversation(任意)
// }

function isValidRating(value: unknown): value is number {

  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );

}

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const satisfaction = body.satisfaction;
    const willingnessToReuse = body.willingnessToReuse;

    if (
      !isValidRating(satisfaction) ||
      !isValidRating(willingnessToReuse)
    ) {

      return NextResponse.json(
        {
          success: false,
          error:
            "satisfaction/willingnessToReuseは1〜5の整数で指定してください。",
        },
        { status: 400 }
      );

    }

    const usefulParts =
      Array.isArray(body.usefulParts)
        ? body.usefulParts.filter(
            (v: unknown): v is string => typeof v === "string"
          )
        : [];

    const difficulties =
      typeof body.difficulties === "string"
        ? body.difficulties
        : "";

    const wantedFeatures =
      typeof body.wantedFeatures === "string"
        ? body.wantedFeatures
        : "";

    const conversationId =
      typeof body.conversationId === "string"
        ? body.conversationId
        : undefined;

    const record = {

      submittedAt: new Date().toISOString(),

      satisfaction,

      usefulParts,

      difficulties,

      willingnessToReuse,

      wantedFeatures,

      conversationId,

    };

    const logDir =
      path.join(process.cwd(), "logs");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir);
    }

    const fileName =
      `${Date.now()}-beta-feedback.json`;

    fs.writeFileSync(
      path.join(logDir, fileName),
      JSON.stringify(record, null, 2)
    );

    return NextResponse.json({
      success: true,
    });

  } catch (error) {

    console.error(
      "Failed to save beta feedback:",
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
