import { NextRequest, NextResponse } from "next/server";

import { getConversation, getConversationMessages } from "@/core/tact-conversation";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/tact-conversations/[conversationId]/messages (Phase 66)
// =========================
//
// core/tact-conversation/store.tsのgetConversationMessages()は
// conversation_idのみで絞り込み、RLSを唯一の所有者境界として扱う
// 設計になっている(tact_conversation_messagesにはuser_id列が存在せず、
// Phase65時点でアプリケーション層に追加でチェックできる列がない)。
//
// このAPI Routeでは、Section15(IDOR/Cross-user read対策)のため、
// メッセージ取得より前に必ずgetConversation()で所有権を明示的に検証する
// (RLSのみに依存しない、Phase65 store.tsの一貫方針をAPI層でも維持)。
// 他Userのconversationidの場合、存在確認自体がここで404となり、
// getConversationMessages()には到達しない。

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

    const messages = await getConversationMessages(conversationId, accessToken);

    return NextResponse.json({
      success: true,
      messages,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to get conversation messages",
      },
      {
        status: 500,
      }
    );

  }

}
