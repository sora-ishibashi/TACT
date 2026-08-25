import { NextRequest, NextResponse } from "next/server";

import { createSupabaseCoreCapability } from "@/core/tact-core/supabaseCoreCapability";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/knowledge (Phase 74)
// =========================
//
// Phase73 Investigation Section7で判明した通り、Research/Orchestrator
// 実行結果はcore/tact-orchestrator/memoryWriter.ts(Phase5、既存)経由で
// 既にtact_core_knowledgeへ自動的に書き込まれているが、これを閲覧する
// APIが1件も存在しなかった(grep確認済み)。このRouteはその読み取りだけを
// 追加する——recordKnowledge()・Research/Orchestrator・schemaのいずれも
// 変更しない(Phase74 Section7/10「新しいFileシステムを作らない、
// 既存KnowledgeをUI上から閲覧できるようにする」)。
//
// 既存core/tact-core/supabaseCoreCapability.tsのretrieveKnowledge()を
// そのまま呼ぶだけで、新しいSupabase queryはここに書かない
// (app/api/tact/core/push/route.tsと同じ責務分離方針)。
//
// User Scopeのみ(既存の制約、STEP208): organizationId/projectId/
// conversationIdをここから渡すと例外になるため、userIdだけを渡す
// (Phase73 Evidence: project/conversation scopeは未実装)。
//
// query:
// {
//   limit?: number,
//   query?: string  // 簡易keyword relevance検索(既存の仕組みをそのまま使う)
// }

export async function GET(
  request: NextRequest
) {

  try {

    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId) {

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

    const { searchParams } = new URL(request.url);

    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : NaN;

    const query = searchParams.get("query") ?? undefined;

    const core = createSupabaseCoreCapability();

    const knowledge = await core.retrieveKnowledge({
      userId: authenticatedUserId,
      query,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 30,
    });

    return NextResponse.json({
      success: true,
      knowledge,
    });

  } catch (error) {

    console.error("TACT Knowledge list failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to list knowledge",
      },
      {
        status: 500,
      }
    );

  }

}
