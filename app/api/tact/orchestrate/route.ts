import { NextRequest, NextResponse } from "next/server";

import { runOrchestration } from "@/core/tact-orchestrator";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/orchestrate (Phase 33)
// =========================
//
// Phase32の調査結果に基づく、core/tact-orchestrator/runOrchestration()
// (Phase1〜28で構築済み、これまでどのAPI Routeからも呼ばれていな
// かった)を外部から呼び出し可能にするためだけの、完全に独立した
// 新規Route。
//
// 既存の/api/tact/research・/api/tact/chatは一切変更しない。
// このRouteはrunResearch()/runChat()/classifyIntent()を直接呼ばず、
// runOrchestration()だけを呼ぶ(Commander→Executor→research
// capability→runResearch()という既存の責務分離をそのまま利用する、
// Phase32絶対条件10)。
//
// body:
// {
//   input: string
// }
//
// userIdはAuthorization: Bearer <access_token>ヘッダーをserver側で
// 検証して取得する(既存core/auth/getUserContext.ts、STEP131以来の
// 既存方針をそのまま再利用。新しい認証ユーティリティは作らない)。
// クライアントからのuserId/projectId/organizationId/conversationId/
// intent/constraintsは受け取らない(Phase32調査: 現在UI/API層に
// これらを保持・伝播する経路自体が存在しないため、絶対条件6・9に
// 従い今回は繋がない)。
//
// 未認証の場合はrunOrchestration()を呼び出さず、即座に401を返す
// (Phase33絶対条件2「認証失敗時にはrunOrchestration()を呼ばない
// こと」)。/api/tact/research・/api/tact/chatは「未認証でも拒否
// しない」既存方針だが、このRouteは新規かつOrchestrator実験用の
// 入口であるため、Phase33の指示に従い明示的に401とする
// (app/api/tact/projects/route.ts、Phase31と同じ判断)。
//
// レスポンス: OrchestrationResultをそのまま返す。新しいResponse DTO・
// 変換層は作らない(絶対条件6: answer/tasks/clarification/
// learningSignals/memoryUsed/toolsUsed/memoryWrites/metadata等、
// 既存フィールドをそのまま外部から観測可能にする)。

export async function POST(
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

    const body = await request.json();

    const input =
      typeof body.input === "string" ? body.input.trim() : "";

    if (!input) {

      return NextResponse.json(
        {
          success: false,
          error: "input is required and must be a non-empty string",
        },
        {
          status: 400,
        }
      );

    }

    const result = await runOrchestration({
      userId: authenticatedUserId,
      input,
    });

    return NextResponse.json(result);

  } catch (error) {

    console.error(
      "TACT Orchestrate API failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: "failed to run orchestration",
      },
      {
        status: 500,
      }
    );

  }

}
