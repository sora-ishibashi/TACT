// =========================
// TACT Bot — Identity Store Regression (BOT-P2, pure functions)
// =========================
//
// 対象: core/tact-bot/identity/supabaseIdentityStore.ts の
// isLinkableChannel()。実際のDBアクセス関数(findExternalIdentity/
// linkExternalIdentity)はSupabase service role clientに依存するため、
// このrepositoryの既存方針(core/tact-attachment/repository.ts等と
// 同じ、実DBアクセスを伴うcodeは自動テスト対象外)に従い、ここでは
// テストしない。
//
// 環境制約: 実Supabase接続は一切行わない。LLM/Search API呼び出しも0。

import "dotenv/config";
import { isLinkableChannel } from "../../../core/tact-bot/identity/supabaseIdentityStore";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Test1-1] slack/line/teams/discordはlinkable",
      isLinkableChannel("slack") &&
        isLinkableChannel("line") &&
        isLinkableChannel("teams") &&
        isLinkableChannel("discord")
    )
  );

  results.push(
    check(
      "[Test1-2] unknownはlinkableでない(識別できないchannelをidentity解決対象にしない)",
      isLinkableChannel("unknown") === false
    )
  );

  return summarize("bot/identityStore", results);

}
