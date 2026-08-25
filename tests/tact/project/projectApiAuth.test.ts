// =========================
// Project API — Authentication Regression (Phase 31)
// =========================
//
// 対象: app/api/tact/projects/route.ts・
// app/api/tact/projects/[projectId]/route.ts の未認証時の挙動。
//
// 実際のRoute Handler(POST/GET/PATCH/DELETE)を直接importして呼び出す
// (Next.jsのRoute Handlerはただの非同期関数のため、HTTPサーバーを
// 起動せずに直接呼び出して検証できる)。Authorizationヘッダーを
// 付けないため、core/auth/getAuthenticatedUser.ts内部のtoken検証
// (supabase.auth.getUser())自体が実行されず、実Supabaseへの
// ネットワーク呼び出みは発生しない(LLM/API/DB call = 0)。
//
// 認証成功後のcreate/list/get/update/delete/ownershipについては、
// このHarness環境ではSupabase Service Role Keyが無く、かつメール
// 送信レート制限のため新規テストUserの実セッションを取得できない
// (Phase30/31で実測確認済み)。そのため、これらは
// `supabase db query --linked`によるauth.uid()ロールシミュレーション
// で実DBに対して実行し(Phase31完了報告に記載)、npm testの恒久
// Regressionには含めない——npm testが常に外部依存0で完結するという
// Phase20以来の設計原則を優先した判断(絶対条件外だが理由を明記)。

import "dotenv/config";
import { NextRequest } from "next/server";
import { POST as createProjectRoute, GET as listProjectsRoute } from "../../../app/api/tact/projects/route";
import {
  GET as getProjectRoute,
  PATCH as patchProjectRoute,
  DELETE as deleteProjectRoute,
} from "../../../app/api/tact/projects/[projectId]/route";
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

  const fakeParams = Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000000" });

  const create = await createProjectRoute(
    makeRequest("POST", "http://localhost/api/tact/projects", { name: "x" })
  );
  results.push(
    check("[Phase31] POST /api/tact/projects (未認証) -> 401", create.status === 401, `status=${create.status}`)
  );

  const list = await listProjectsRoute(
    makeRequest("GET", "http://localhost/api/tact/projects")
  );
  results.push(
    check("[Phase31] GET /api/tact/projects (未認証) -> 401", list.status === 401, `status=${list.status}`)
  );

  const get = await getProjectRoute(
    makeRequest("GET", "http://localhost/api/tact/projects/x"),
    { params: fakeParams }
  );
  results.push(
    check("[Phase31] GET /api/tact/projects/[id] (未認証) -> 401", get.status === 401, `status=${get.status}`)
  );

  const patch = await patchProjectRoute(
    makeRequest("PATCH", "http://localhost/api/tact/projects/x", { name: "y" }),
    { params: fakeParams }
  );
  results.push(
    check("[Phase31] PATCH /api/tact/projects/[id] (未認証) -> 401", patch.status === 401, `status=${patch.status}`)
  );

  const del = await deleteProjectRoute(
    makeRequest("DELETE", "http://localhost/api/tact/projects/x"),
    { params: fakeParams }
  );
  results.push(
    check("[Phase31] DELETE /api/tact/projects/[id] (未認証) -> 401", del.status === 401, `status=${del.status}`)
  );

  // レスポンスJSONの形も確認(success:false、errorが他Userの情報等を
  // 含まない一般的な文言であること)。
  const createBody = await create.json();
  results.push(
    check(
      "[Phase31] 401レスポンスの形式(success:false、一般的なerror文言)",
      createBody.success === false && typeof createBody.error === "string",
      `body=${JSON.stringify(createBody)}`
    )
  );

  return summarize("project API auth", results);

}
