// =========================
// TACT Bot — /api/tact/bot/slack Route Regression (S1a)
// =========================
//
// 対象: app/api/tact/bot/slack/route.ts。
//
// 環境上の制約(tests/tact/orchestrator/orchestrateRoute.test.tsと
// 同じ既存方針): このtest環境にはSLACK_SIGNING_SECRETが設定されて
// いないため、実POST()を直接呼び出しても署名検証より前段の
// "not_configured"(401)経路しか実際には確定的に検証できない
// (network呼び出み・DBアクセスは一切発生しないため0コストで確定的)。
// signature検証・dedup・normalization・receiveBotMessage呼び出し等の
// 詳細な分岐は、DI可能なcore/tact-bot/adapters/slack/
// handleSlackWebhookRequest.ts自体を対象とする
// tests/tact/bot/slackWebhookHandler.test.tsが担う——このfileは
// 「route.ts自体が正しくhandleSlackWebhookRequest()へ委譲し、
// 実際にHTTP応答として観測可能な形で返す」という配線だけを確認する。

import "dotenv/config";
import { NextRequest } from "next/server";
import { POST as slackWebhookRoute } from "../../../app/api/tact/bot/slack/route";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import { check, summarize, type CheckResult } from "../lib/check";

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {

  return new NextRequest("http://localhost/api/tact/bot/slack", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Precondition] このtest環境ではSLACK_SIGNING_SECRETが未設定である(設定済みの場合、以下のtestは前提が崩れる)",
      typeof process.env.SLACK_SIGNING_SECRET !== "string" || process.env.SLACK_SIGNING_SECRET.length === 0
    )
  );

  // SUPABASE_SERVICE_ROLE_KEYもこのtest環境では未設定である前提
  // (dedup claimに到達しても実DBへは書き込まれない、絶対条件Section29)。
  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYも未設定である(live Supabase mutationが発生しないことの前提確認)",
      isServiceRoleConfigured() === false
    )
  );

  // ---- Signing Secret未設定 -> route経由でも401・not_configured ----
  {
    const response = await slackWebhookRoute(
      makeRequest(
        { type: "event_callback", event_id: "Ev1", event: { type: "app_mention", user: "U1", text: "hi", ts: "1", channel: "C1" } },
        { "x-slack-signature": "v0=whatever", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) }
      )
    );

    const body = await response.json();

    results.push(
      check(
        "[Route] Signing Secret未設定環境では、実POST()呼び出しでも401・error:not_configuredを返す(handleSlackWebhookRequest()への委譲が機能している直接証拠、live network/DB呼び出しは一切発生しない)",
        response.status === 401 && body.error === "not_configured"
      )
    );
  }

  // ---- 予期しない例外でも200を返さない(fail closed) ----
  // request.text()が読める限りJSON.parse失敗等でも例外にはならない設計
  // (handleSlackWebhookRequest.ts内でtry/catch済み)だが、route.ts自体の
  // 防御的try/catchも直接確認しておく——不正なbody(JSON化不能な
  // ReadableStream異常等)を人工的に作るのは困難なため、ここでは
  // 「実POST()がPromiseをrejectしない(必ずResponseを返す)」ことだけを
  // 確認する。
  {
    let threw = false;

    try {
      await slackWebhookRoute(makeRequest({}));
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[Route/防御的] 空bodyのような不正payloadでも、route自体が例外をthrowせず必ずResponseを返す",
        threw === false
      )
    );
  }

  return summarize("bot/slackWebhookRoute", results);

}
