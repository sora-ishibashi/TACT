import { NextRequest, NextResponse } from "next/server";

import { getArtifact } from "@/core/tact-artifact";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/artifacts/[artifactId] (Phase 75)
// =========================
//
// Phase66のGET /api/tact/tact-conversations/[conversationId]と同じ
// 認証・所有者判定パターン(getCurrentUserContext() + getArtifact()の
// user_id絞り込み、RLSとの二重防御)。ArtifactはArtifact Mutation
// (core/tact-conversation/orchestration.ts)の副作用としてのみ作成・
// 更新される——この Routeは読み取り専用で、DBへ書き込む経路を持たない。

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
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

    const { artifactId } = await params;

    const artifact = await getArtifact(artifactId, authenticatedUserId, accessToken);

    if (!artifact) {

      return NextResponse.json(
        {
          success: false,
          error: "artifact not found",
        },
        {
          status: 404,
        }
      );

    }

    return NextResponse.json({
      success: true,
      artifact,
    });

  } catch (error) {

    console.error("TACT Artifact fetch failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to get artifact",
      },
      {
        status: 500,
      }
    );

  }

}
