import { NextRequest, NextResponse } from "next/server";

import { listConversations } from "@/core/conversation/store";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/conversations
// =========================
//
// Conversation一覧を取得する(STEP9)。既存の
// GET /api/tact/conversation(単体取得、conversationId必須)とは
// 別のエンドポイントとして新設する。
//
// query:
// {
//   limit?: number  // 省略時はlistConversations()側のデフォルト(30)
// }
//
// STEP145-G: サーバー側で検証済みのuserId(getCurrentUserContext()
// 経由)でlistConversations()を絞り込む。クライアントからの
// userId自己申告は引き続き受け取らない(信頼できないため)。
// 未認証の場合はuser_id IS NULLのConversationのみ返す
// (認証導入前の既存データ・未認証フローのデータとの後方互換)。

export async function GET(
  request: NextRequest
) {

  try {

    const { searchParams } = new URL(request.url);

    const limitParam = searchParams.get("limit");

    const parsedLimit =
      limitParam ? Number(limitParam) : NaN;

    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    const conversations =
      await listConversations(
        Number.isFinite(parsedLimit) &&
        parsedLimit > 0
          ? parsedLimit
          : undefined,
        authenticatedUserId
      );

    return NextResponse.json({
      success: true,
      conversations,
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
