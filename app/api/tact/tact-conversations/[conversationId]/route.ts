import { NextRequest, NextResponse } from "next/server";

import { getConversation } from "@/core/tact-conversation";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/tact-conversations/[conversationId] (Phase 66)
// =========================
//
// 所有者判定はcore/tact-conversation/store.tsのgetConversation()自体が
// (RLS + 明示的なuser_id絞り込みの二重で)行う。存在しない場合と
// 他Userのconversationの場合を外部から区別しない(常に404、
// app/api/tact/projects/[projectId]/route.tsの既存方針と同じ——
// Section7-Bの"ユーザー存在を推測できるような情報を返さない"に対応)。

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {

      return NextResponse.json(
        {
          success: false,
          error: "authentication required",
        },
        {
          status: 401,
        }
      );

    }

    const { conversationId } = await params;

    const conversation = await getConversation(
      conversationId,
      authenticatedUserId,
      accessToken
    );

    if (!conversation) {

      return NextResponse.json(
        {
          success: false,
          error: "conversation not found",
        },
        {
          status: 404,
        }
      );

    }

    return NextResponse.json({
      success: true,
      conversation,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to get conversation",
      },
      {
        status: 500,
      }
    );

  }

}
