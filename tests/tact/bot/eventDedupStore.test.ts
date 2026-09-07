// =========================
// TACT Bot — Inbound Event Dedup Store Regression (S1a)
// =========================
//
// 対象: core/tact-bot/eventDedup/supabaseEventDedupStore.tsの
// claimExternalEvent()。
//
// 環境制約(core/tact-bot/execution/trustedConversationTurn.test.tsと
// 同じ既存方針): このtest実行環境にはSUPABASE_SERVICE_ROLE_KEYが
// 設定されていない。そのため、ここでは実関数をそのまま呼び出し、
// 「service role未設定時は一切DBへアクセスせずfail closed("error")を
// 返す」という絶対条件(Section18)だけを確認する(Category A、
// pure/deterministic)。実DB上でのclaimed/duplicate分岐(atomic claim)は
// tests/tact/bot/slackWebhookHandler.test.tsがfake claimExternalEvent
// 経由でhandleSlackWebhookRequest()側のロジックを検証する形で
// 補完する(core/tact-bot/identity/supabaseIdentityStore.tsの既存
// テスト方針と同じく、実DBアクセスを伴う分岐は自動テスト対象外)。

import "dotenv/config";
import { claimExternalEvent } from "../../../core/tact-bot/eventDedup/supabaseEventDedupStore";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYが未設定である(設定済みの場合、以下のtestは実Supabase書き込みを試みてしまうため、前提条件として確認する)",
      isServiceRoleConfigured() === false
    )
  );

  const result = await claimExternalEvent({ channel: "slack", externalEventId: "Ev-test-unconfigured" });

  results.push(
    check(
      "[絶対条件Section18] service role未設定時、claimExternalEvent()はDBへ一切アクセスせず'error'を安全に返す(duplicate扱いで捨てず、claimed扱いで進めもしない、fail closed)",
      result === "error"
    )
  );

  return summarize("bot/eventDedupStore", results);

}
