import { NextRequest, NextResponse } from "next/server";

import { refreshIntegrationConnectionStatus } from "@/core/tact-integration";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/connections/[connectionId]/confirm
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// OAuthはProvider(Composio)側のhosted redirectUrlで完結し、TACTは
// Callback/Webhookを受け取らない(絶対条件、.envを触らない・新しい
// Webhook infrastructureをこのPhaseで追加しない)。このRouteは、
// OAuth完了後にユーザー操作(または今回のLIVE acceptanceの手動
// ステップ)を起点として1回だけ呼ばれ、Providerへ現在statusを
// 問い合わせてcanonical Connection.statusを進める
// (core/tact-integration/provisioning.tsのrefreshIntegrationConnection
// Status()、自動pollingループはこのRoute・呼び出し先のいずれも
// 持たない)。
//
// TRUST BOUNDARY: connectionIdはURLから受け取るが、所有者確認は
// refreshIntegrationConnectionStatus() -> getConnection()の既存
// user_id絞り込みがそのまま担う(他Userのconnectionidを指定した
// 場合はnot_foundと同じ404になる、既存IDOR対策パターン踏襲)。

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {
      return unauthorizedResponse();
    }

    const { connectionId } = await params;

    const outcome = await refreshIntegrationConnectionStatus({
      connectionId,
      userId: authenticatedUserId,
      accessToken,
    });

    if (outcome.status === "not_found") {

      return NextResponse.json(
        {
          success: false,
          error: "connection not found",
        },
        {
          status: 404,
        }
      );

    }

    if (outcome.status === "unsupported_provider") {

      return NextResponse.json(
        {
          success: false,
          error: "this connection's provider is not supported for status refresh",
        },
        {
          status: 400,
        }
      );

    }

    if (outcome.status === "provider_not_configured") {

      return NextResponse.json(
        {
          success: false,
          error: "this connection is not currently available",
        },
        {
          status: 503,
        }
      );

    }

    // 絶対条件(Connected Account IDを露出しない): providerConnectionRef
    // をレスポンスへ含めない、canonical statusのみ返す。
    return NextResponse.json({
      success: true,
      connection: {
        id: outcome.connection.id,
        service: outcome.connection.service,
        status: outcome.connection.status,
        provider: outcome.connection.provider,
        createdAt: outcome.connection.createdAt,
        updatedAt: outcome.connection.updatedAt,
      },
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to refresh connection status",
      },
      {
        status: 500,
      }
    );

  }

}
