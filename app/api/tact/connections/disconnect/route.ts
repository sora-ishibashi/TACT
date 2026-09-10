import { NextRequest, NextResponse } from "next/server";

import { disconnectIntegrationConnection } from "@/core/tact-integration";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/connections/disconnect
// (PRODUCT-P1: Connection UX — Disconnect / SEC-R1 P1)
// =========================
//
// TRUST BOUNDARY(絶対条件、最重要、app/api/tact/connections/route.ts
// と全く同じ既存パターン): このRouteはtactUserIdをgetCurrentUserContext
// (request)経由でのみ解決する。bodyから読み取るのはserviceだけ——
// connectionId/providerConnectionRef等は一切受け取らない(このRoute
// は「このuserのこのserviceの現在activeな接続を全て解除する」という
// 意味論のため、そもそも特定のconnectionIdをcallerから受け取る設計に
// していない——複数activeが誤って存在するerror stateでも同じ操作で
// 自己修復できるようにするため、core/tact-integration/provisioning.ts
// のdisconnectIntegrationConnection()参照)。
//
// Provider側のConnected Account無効化はbest-effort(設計理由は
// disconnectIntegrationConnection()のコメント参照)。このRoute自体は
// その結果を一切覗き見ない——canonical outcomeだけを見て応答する。

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

export type ParsedDisconnectRequestBody =
  | { ok: true; service: string }
  | { ok: false; error: string };

export function parseDisconnectRequestBody(
  body: unknown
): ParsedDisconnectRequestBody {

  if (!body || typeof body !== "object") {
    return { ok: false, error: "request body must be a JSON object" };
  }

  const rawService = (body as Record<string, unknown>).service;

  if (typeof rawService !== "string" || rawService.length === 0) {
    return { ok: false, error: "service is required" };
  }

  return { ok: true, service: rawService };

}

export async function POST(
  request: NextRequest
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {
      return unauthorizedResponse();
    }

    const body = await request.json().catch(() => null);

    const parsed = parseDisconnectRequestBody(body);

    if (!parsed.ok) {

      return NextResponse.json(
        {
          success: false,
          error: parsed.error,
        },
        {
          status: 400,
        }
      );

    }

    // 絶対条件(IDENTITY INVARIANT): userIdはgetCurrentUserContext()が
    // 解決したauthenticatedUserIdのみを渡す。
    const outcome = await disconnectIntegrationConnection({
      userId: authenticatedUserId,
      accessToken,
      service: parsed.service,
    });

    if (outcome.status === "unsupported_service") {

      return NextResponse.json(
        {
          success: false,
          error: `unsupported service: ${parsed.service}`,
        },
        {
          status: 400,
        }
      );

    }

    // "not_connected"も"disconnected"も、呼び出し元(UI)から見れば
    // 「解除後、activeな接続が無い」という同じ成功結果として扱ってよい
    // (絶対条件: 二重クリック等で例外にしない、冪等性)。
    return NextResponse.json({
      success: true,
      revokedCount: outcome.status === "disconnected" ? outcome.revokedConnectionIds.length : 0,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to disconnect",
      },
      {
        status: 500,
      }
    );

  }

}
