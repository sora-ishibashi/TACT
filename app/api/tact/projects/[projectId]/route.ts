import { NextRequest, NextResponse } from "next/server";

import {
  getProject,
  updateProjectName,
  deleteProject,
} from "@/core/tact-project/store";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET / PATCH / DELETE /api/tact/projects/[projectId] (Phase 31)
// =========================
//
// 3メソッドとも同じ所有者判定(project.id = projectId AND
// project.user_id = authenticatedUser.id)を使う。存在しない場合と
// 他UserのProjectの場合を外部から区別しない(常に404、
// app/api/tact/conversation/route.tsの既存方針と同じ)。

async function requireAuthenticatedUser(request: NextRequest) {

  const { userId, accessToken } = await getCurrentUserContext(request);

  if (!userId || !accessToken) {
    return null;
  }

  return { userId, accessToken };

}

function notFoundResponse() {

  return NextResponse.json(
    {
      success: false,
      error: "project not found",
    },
    {
      status: 404,
    }
  );

}

function unauthorizedResponse() {

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {

  try {

    const auth = await requireAuthenticatedUser(request);

    if (!auth) {
      return unauthorizedResponse();
    }

    const { projectId } = await params;

    const project = await getProject(
      auth.userId,
      auth.accessToken,
      projectId
    );

    if (!project) {
      return notFoundResponse();
    }

    return NextResponse.json({
      success: true,
      project,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to get project",
      },
      {
        status: 500,
      }
    );

  }

}

// body:
// {
//   name: string
// }
//
// user_id/idはbodyから受け取らない・変更できない
// (core/tact-project/store.tsのupdateProjectName()のシグネチャ自体が
// nameしか受け取らない)。

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {

  try {

    const auth = await requireAuthenticatedUser(request);

    if (!auth) {
      return unauthorizedResponse();
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

    const { projectId } = await params;

    const project = await updateProjectName(
      auth.userId,
      auth.accessToken,
      projectId,
      name
    );

    if (!project) {
      return notFoundResponse();
    }

    return NextResponse.json({
      success: true,
      project,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to update project",
      },
      {
        status: 500,
      }
    );

  }

}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {

  try {

    const auth = await requireAuthenticatedUser(request);

    if (!auth) {
      return unauthorizedResponse();
    }

    const { projectId } = await params;

    // conversations.project_idをNULLへ戻す処理はPhase30のON DELETE
    // SET NULLがDB側で行う。ここでConversationを手動更新・削除する
    // 処理は追加しない(絶対条件)。
    const deleted = await deleteProject(
      auth.userId,
      auth.accessToken,
      projectId
    );

    if (!deleted) {
      return notFoundResponse();
    }

    return NextResponse.json({
      success: true,
      projectId,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to delete project",
      },
      {
        status: 500,
      }
    );

  }

}
