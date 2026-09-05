// =========================
// TACT Bot — Trusted Bot Execution Boundary Regression (BOT-P2.5)
// =========================
//
// 対象: core/tact-bot/execution/trustedConversationTurn.tsの
// runConversationTurnAsTrustedActor()。
//
// 環境制約: このtest実行環境にはSUPABASE_SERVICE_ROLE_KEYが設定されて
// いない(BOT-P2/BOT-P2.5時点の既定状態、supabase/migrations/
// 20260830010000_create_tact_bot_identity_tables.sqlはまだ実Supabaseへ
// 未適用)。そのため、ここではmockを使わず実関数をそのまま呼び出し、
// 「未設定時は一切DBへアクセスせず安全にfallbackする」という
// 分岐だけを確認する(Category A、pure/deterministic)。
// 「設定済み」経路(実Supabase書き込み)はcore/tact-attachment/
// repository.ts等と同じ既存repository方針により、ここではテスト
// しない。

import "dotenv/config";
import { runConversationTurnAsTrustedActor } from "../../../core/tact-bot/execution/trustedConversationTurn";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYが未設定である" +
        "(設定済みの場合、以下のtestは実Supabase書き込みを試みてしまうため、前提条件として確認する)",
      isServiceRoleConfigured() === false
    )
  );

  const result = await runConversationTurnAsTrustedActor({
    tactUserId: "tact-user-1",
    content: "SROIについて調べて",
  });

  results.push(
    check(
      "[Test1-1] service role未設定時はok:false・error:trusted_execution_not_configuredを返す(DBへ一切アクセスしない)",
      result.ok === false && result.error === "trusted_execution_not_configured"
    )
  );

  results.push(
    check(
      "[Test1-2] エラー結果にservice role key等の生Credentialが含まれない(JSON化しても環境変数名以外の秘匿情報を含まない)",
      !JSON.stringify(result).toLowerCase().includes("bearer") &&
        !JSON.stringify(result).includes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "__unset__")
    )
  );

  const conversationIdResult = await runConversationTurnAsTrustedActor({
    tactUserId: "tact-user-1",
    content: "続きの依頼",
    conversationId: "conv-1",
  });

  results.push(
    check(
      "[Test1-3] conversationId指定時も同じく安全にfallbackする(引数に関わらず未設定なら常にDBへアクセスしない)",
      conversationIdResult.ok === false && conversationIdResult.error === "trusted_execution_not_configured"
    )
  );

  return summarize("bot/trustedConversationTurn", results);

}
