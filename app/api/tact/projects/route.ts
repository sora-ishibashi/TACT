import { NextRequest, NextResponse } from "next/server";

import {
  createProject,
  listProjects,
} from "@/core/tact-project/store";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/projects (Phase 31)
// =========================
//
// body:
// {
//   name: string
// }
//
// user_idはbodyから受け取らない。projects.user_idは必ず
// getCurrentUserContext()が検証したuserIdを使う
// (core/auth/getAuthenticatedUser.ts、STEP131以来の既存方針)。
//
// 未認証(userId/accessTokenが確定しない)の場合は401。既存
// Conversation APIは未認証でも許可する既存方針(STEP131)だが、
// Projectは新規リソースであり、Phase30のRLS(auth.uid()ベース)自体が
// 未認証操作を成立させない(accessTokenが無ければRLSを満たす
// クライアントを構築できない)ため、ここでは明示的に401とする。

export async function POST(
  request: NextRequest
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

    const body = await request.json();

    const name =
      typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {

      return NextResponse.json(
        {
          success: false,
          error: "name is required and must be a non-empty string",
        },
        {
          status: 400,
        }
      );

    }

    const project = await createProject(
      authenticatedUserId,
      accessToken,
      name
    );

    return NextResponse.json({
      success: true,
      project,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to create project",
      },
      {
        status: 500,
      }
    );

  }

}

// =========================
// GET /api/tact/projects (Phase 31)
// =========================
//
// 現在の認証Userが所有するProject一覧を返す(updated_at降順)。
// 他Userのprojectは一切返さない(store.ts側でuser_idを明示的に
// 絞り込み、かつRLSでも二重に保証される)。

export async function GET(
  request: NextRequest
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

    const projects = await listProjects(
      authenticatedUserId,
      accessToken
    );

    return NextResponse.json({
      success: true,
      projects,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to list projects",
      },
      {
        status: 500,
      }
    );

  }

}
