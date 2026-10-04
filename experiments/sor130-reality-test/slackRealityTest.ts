// =========================
// SOR-130 Reality Test — Slack (Messaging category)
// =========================
//
// 実Slack Web APIへ実際にauth.test(READ)を行う。chat.postMessage(SEND)
// は、SOR130_SLACK_TEST_CHANNELが明示的に設定されている場合のみ実行
// する(Human承認済みのchannelにのみ実送信する、絶対条件)。未設定なら
// SENDは「未検証」として明示しskipする——mockだけでlive verifiedとは
// 扱わない。

import "./lib/loadDotEnv";

import { randomUUID } from "node:crypto";
import {
  observeSlackWebApiCallExecution,
  getExecutionById,
} from "@tact/runs-core/tact-execution";
import { getServiceRoleClient } from "../../core/database/supabaseServiceRole";
import { applyLocalSupabaseEnv } from "./lib/localSupabaseEnv";
import { ensureRealityTestUser } from "./lib/ensureRealityTestUser";
import { check, printReport, privacySweep, type RealityTestCheck } from "./lib/reportUtils";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TEST_CHANNEL = process.env.SOR130_SLACK_TEST_CHANNEL;

async function slackApi(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main() {

  applyLocalSupabaseEnv();

  if (!SLACK_BOT_TOKEN) {
    console.log("[sor130-reality-test/slack] UNVERIFIED — SLACK_BOT_TOKEN not set.");
    process.exitCode = 0;
    return;
  }

  const results: RealityTestCheck[] = [];
  const client = getServiceRoleClient();

  if (!client) {
    throw new Error("getServiceRoleClient() returned null — SUPABASE_SERVICE_ROLE_KEY was not applied correctly");
  }

  const REALITY_TEST_USER_ID = await ensureRealityTestUser(client);

  // ---- READ: auth.test (real Slack API call, no side effects) ----
  const authTest = await slackApi("auth.test");
  const ok = authTest.ok === true;
  const botUserId = typeof authTest.user_id === "string" ? authTest.user_id : null;
  const teamId = typeof authTest.team_id === "string" ? authTest.team_id : null;

  results.push(check("[READ] real Slack auth.test call succeeded", ok, JSON.stringify({ ok, error: authTest.error })));

  const authInvocationId = `sor130-slack-auth-${randomUUID()}`;

  await observeSlackWebApiCallExecution({
    userId: REALITY_TEST_USER_ID,
    invocationId: authInvocationId,
    operation: "AUTH_TEST",
    botUserId,
    teamId,
    status: ok ? "succeeded" : "failed",
    errorCode: ok ? null : "slack_api_call_failed",
  });

  const authRow = client
    ? await client
        .from("tact_canonical_executions")
        .select("id")
        .eq("user_id", REALITY_TEST_USER_ID)
        .eq("external_event_id", authInvocationId)
        .maybeSingle()
    : { data: null };
  const authExecutionId = (authRow.data as { id?: string } | null)?.id ?? null;
  results.push(check("[READ] CanonicalExecution row persisted for auth.test", !!authExecutionId));

  if (authExecutionId) {
    const persisted = await getExecutionById(authExecutionId, REALITY_TEST_USER_ID);
    results.push(check("[readback] persisted execution row is queryable via getExecutionById()", !!persisted));
    results.push(privacySweep(persisted, [SLACK_BOT_TOKEN]));
    results.push(
      check(
        "[observationMode] recorded as 'instrumented' (TACT's own code wraps the real Slack call, distinct from the existing reconciled inbound adapter)",
        !!persisted && persisted.observationMode === "instrumented"
      )
    );
  }

  // ---- SEND: chat.postMessage — only with an explicitly approved test channel ----
  if (!TEST_CHANNEL) {
    console.log(
      "[sor130-reality-test/slack] SEND (chat.postMessage) UNVERIFIED — SOR130_SLACK_TEST_CHANNEL not set. " +
        "Awaiting an explicitly approved channel id before sending any real message."
    );
  } else {

    const postRes = await slackApi("chat.postMessage", {
      channel: TEST_CHANNEL,
      text: "TACT SOR-130 Generic Observation Gateway reality test message (safe to ignore/delete).",
    });
    const sendOk = postRes.ok === true;
    const messageTs = typeof postRes.ts === "string" ? postRes.ts : null;

    results.push(check("[SEND] real Slack chat.postMessage call", sendOk, JSON.stringify({ ok: sendOk, error: postRes.error })));

    const sendInvocationId = `sor130-slack-send-${randomUUID()}`;

    await observeSlackWebApiCallExecution({
      userId: REALITY_TEST_USER_ID,
      invocationId: sendInvocationId,
      operation: "CHAT_POST_MESSAGE",
      botUserId,
      teamId,
      channel: TEST_CHANNEL,
      messageTs,
      status: sendOk ? "succeeded" : "failed",
      errorCode: sendOk ? null : "slack_channel_not_found",
    });

    // ---- Duplicate invocation (reuse invocationId, no second real send) ----
    await observeSlackWebApiCallExecution({
      userId: REALITY_TEST_USER_ID,
      invocationId: sendInvocationId,
      operation: "CHAT_POST_MESSAGE",
      botUserId,
      teamId,
      channel: TEST_CHANNEL,
      messageTs,
      status: sendOk ? "succeeded" : "failed",
    });

    const duplicateRows = client
      ? await client
          .from("tact_canonical_executions")
          .select("id")
          .eq("user_id", REALITY_TEST_USER_ID)
          .eq("external_event_id", sendInvocationId)
      : { data: [] };

    results.push(
      check(
        "[duplicate] re-observing the same invocationId does not create a second row",
        Array.isArray(duplicateRows.data) && duplicateRows.data.length === 1
      )
    );

    // ---- Intentional failure: post to a nonexistent channel ----
    const failRes = await slackApi("chat.postMessage", {
      channel: "C000000000INVALID",
      text: "This should fail (nonexistent channel).",
    });

    results.push(check("[intentional failure] posting to a nonexistent channel returns a real Slack error", failRes.ok !== true, String(failRes.error)));

    await observeSlackWebApiCallExecution({
      userId: REALITY_TEST_USER_ID,
      invocationId: `sor130-slack-fail-${randomUUID()}`,
      operation: "CHAT_POST_MESSAGE",
      botUserId,
      teamId,
      channel: "C000000000INVALID",
      status: "failed",
      errorCode: "slack_channel_not_found",
    });

  }

  printReport("Slack", results);

}

main().catch((error) => {
  console.error("[sor130-reality-test/slack] fatal error", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
