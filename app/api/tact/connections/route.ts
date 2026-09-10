import { NextRequest, NextResponse } from "next/server";

import {
  createIntegrationConnectionLink,
  listConnectionsForUser,
} from "@/core/tact-integration";
import type { Connection } from "@/core/tact-integration";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET / POST /api/tact/connections
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// TRUST BOUNDARY(絶対条件、最重要): このRouteはtactUserIdを
// getCurrentUserContext(request)経由でのみ解決する。POST bodyに
// userId/providerConnectionRef/Composio識別子が含まれていても一切
// 読み取らない(parseCreateConnectionLinkRequestBody()がservice以外の
// fieldを構造的に無視する)。認証成功後の処理は既存
// app/api/tact/projects/route.ts・app/api/tact/tact-conversations/
// route.tsと全く同じ「認証 -> input validation -> Domain layer呼び出し
// -> response mapping」という既存パターンを踏襲する。
//
// 絶対条件(最重要): Composio Connected Account ID(Connection.
// providerConnectionRef)は通常product userへ一切露出しない
// (「expose Connected Account IDs to normal product users」禁止)。
// このfileはtoPublicConnection()で必ずこのfieldを取り除いてから
// レスポンスへ載せる。

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

// Connection(core/tact-integration/types.ts)からproviderConnectionRef
// (Composio connected account id)を取り除いた、外部公開用の最小shape。
// service/status/providerだけがproduct userにとって意味のある情報
// (絶対条件: Connected Account IDを露出しない)。
interface PublicConnection {
  id: string;
  service: Connection["service"];
  status: Connection["status"];
  provider: Connection["provider"];
  createdAt: string;
  updatedAt: string;
}

function toPublicConnection(connection: Connection): PublicConnection {

  return {
    id: connection.id,
    service: connection.service,
    status: connection.status,
    provider: connection.provider,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };

}

export async function GET(
  request: NextRequest
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {
      return unauthorizedResponse();
    }

    const { searchParams } = new URL(request.url);
    const rawService = searchParams.get("service");

    const connections = await listConnectionsForUser(
      authenticatedUserId,
      accessToken,
      rawService === "slack" || rawService === "gmail" ? rawService : undefined
    );

    return NextResponse.json({
      success: true,
      connections: connections.map(toPublicConnection),
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to list connections",
      },
      {
        status: 500,
      }
    );

  }

}

// body: { service: "slack" | "gmail" }
//
// 絶対条件(TRUST BOUNDARY): bodyから読み取るのはserviceだけ。
// userId/providerConnectionRef等、他のfieldが含まれていても
// 構造的に無視する(このparse関数のreturn型自体にそれらのfieldが
// 存在しない)。

export type ParsedCreateConnectionLinkRequestBody =
  | { ok: true; service: string }
  | { ok: false; error: string };

export function parseCreateConnectionLinkRequestBody(
  body: unknown
): ParsedCreateConnectionLinkRequestBody {

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

    const parsed = parseCreateConnectionLinkRequestBody(body);

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

    // PRODUCT-P1(Connection UX、OAuth Return Flow): origin解決は
    // このHTTP層の責務(core/tact-integration/provisioning.tsはHTTP
    // requestを一切知らない、絶対条件)。OAuth完了後、ProviderはTACT
    // Settings画面(?section=settingsでConnections UIを自動選択させる、
    // components/tact/ProductLauncher.tsxのTactSection="settings")へ
    // ブラウザを差し戻す。connectionId query paramはこのURLへ
    // createIntegrationConnectionLink()自身が追加する(呼び出し元
    // であるこのfileはconnectionIdをまだ知らないため)。
    const callbackUrl = `${request.nextUrl.origin}/?section=settings`;

    // 絶対条件(IDENTITY INVARIANT): userIdはgetCurrentUserContext()が
    // 解決したauthenticatedUserIdのみを渡す(bodyのuserIdは既に
    // parseCreateConnectionLinkRequestBody()の戻り値に存在しない
    // ため、ここで渡しようがない)。
    const outcome = await createIntegrationConnectionLink({
      userId: authenticatedUserId,
      accessToken,
      service: parsed.service,
      callbackUrl,
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

    return NextResponse.json({
      success: true,
      connection: toPublicConnection(outcome.connection),
      redirectUrl: outcome.redirectUrl,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to create connection link",
      },
      {
        status: 500,
      }
    );

  }

}
