// =========================
// Connections API — Authentication & Trust Boundary Regression
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// 対象: app/api/tact/connections/route.ts・
// app/api/tact/connections/[connectionId]/confirm/route.tsの
// 未認証時の挙動、およびparseCreateConnectionLinkRequestBody()の
// input validation。tests/tact/project/projectApiAuth.test.tsと同じ
// 既存パターン(実Route Handlerを直接importして呼び出す、
// Authorizationヘッダーを付けないため実Supabaseへのネットワーク
// 呼び出しは発生しない)。

import "dotenv/config";
import { NextRequest } from "next/server";
import {
  GET as listConnectionsRoute,
  POST as createConnectionLinkRoute,
  parseCreateConnectionLinkRequestBody,
} from "../../../app/api/tact/connections/route";
import { POST as confirmConnectionRoute } from "../../../app/api/tact/connections/[connectionId]/confirm/route";
import { check, summarize, type CheckResult } from "../lib/check";

function makeRequest(method: string, url: string, body?: unknown): NextRequest {

  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // TRUST BOUNDARY: unauthenticated -> 401
  // =========================

  const list = await listConnectionsRoute(
    makeRequest("GET", "http://localhost/api/tact/connections")
  );
  results.push(
    check("[LIVE-1A] GET /api/tact/connections (未認証) -> 401", list.status === 401, `status=${list.status}`)
  );

  const create = await createConnectionLinkRoute(
    makeRequest("POST", "http://localhost/api/tact/connections", { service: "gmail" })
  );
  results.push(
    check(
      "[LIVE-1A] POST /api/tact/connections (未認証) -> 401",
      create.status === 401,
      `status=${create.status}`
    )
  );

  // TRUST BOUNDARY: 未認証requestがuserIdを詐称しても401のまま
  // (認証チェックがbody解析より前に行われる)。
  const createWithForgedUserId = await createConnectionLinkRoute(
    makeRequest("POST", "http://localhost/api/tact/connections", {
      service: "gmail",
      userId: "victim-user-id",
      providerConnectionRef: "ca_forged_123",
    })
  );
  results.push(
    check(
      "[LIVE-1A] 未認証requestがuserId/providerConnectionRefを詐称しても401のまま",
      createWithForgedUserId.status === 401
    )
  );

  const confirm = await confirmConnectionRoute(
    makeRequest("POST", "http://localhost/api/tact/connections/conn-1/confirm"),
    { params: Promise.resolve({ connectionId: "conn-1" }) }
  );
  results.push(
    check(
      "[LIVE-1A] POST /api/tact/connections/[id]/confirm (未認証) -> 401",
      confirm.status === 401,
      `status=${confirm.status}`
    )
  );

  const createBody = await create.json();
  results.push(
    check(
      "[LIVE-1A] 401レスポンスの形式(success:false、一般的なerror文言)",
      createBody.success === false && typeof createBody.error === "string"
    )
  );

  // =========================
  // parseCreateConnectionLinkRequestBody(): 純粋関数、認証不要
  // =========================

  results.push(
    check(
      "[LIVE-1A] service以外のfield(userId/providerConnectionRef等)は構造的に無視される",
      (() => {
        const parsed = parseCreateConnectionLinkRequestBody({
          service: "gmail",
          userId: "victim-user-id",
          providerConnectionRef: "ca_forged_123",
        });
        return (
          parsed.ok === true &&
          parsed.service === "gmail" &&
          Object.keys(parsed).sort().join(",") === "ok,service"
        );
      })()
    )
  );

  results.push(
    check(
      "[LIVE-1A] serviceが欠如したbodyはok:falseを返す(400へfail closed)",
      parseCreateConnectionLinkRequestBody({}).ok === false
    )
  );

  results.push(
    check(
      "[LIVE-1A] serviceが文字列でないbodyはok:falseを返す",
      parseCreateConnectionLinkRequestBody({ service: 123 }).ok === false
    )
  );

  results.push(
    check(
      "[LIVE-1A] JSON objectでないbodyはok:falseを返す",
      parseCreateConnectionLinkRequestBody(null).ok === false
    )
  );

  return summarize("integration/connectionsApi", results);

}
