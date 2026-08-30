// =========================
// TACT Bot — Identity Resolver Regression (BOT-P1)
// =========================
//
// 対象: core/tact-bot/identity/resolver.ts(unresolvedIdentityResolver)。
//
// 環境制約: DOM/DB/実Slack・LINE APIには一切依存しない。
// LLM/Search API呼び出しも0。

import "dotenv/config";
import { unresolvedIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type { BotActor } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const actor: BotActor = { externalUserId: "U999", displayName: "Someone" };

  const resolved = await unresolvedIdentityResolver.resolve(actor, "slack");

  results.push(
    check(
      "[Test1-1] BOT-P1 defaultはnull(未解決)を返す(永続的mappingが無いため、存在しないTACT userへfallbackしない)",
      resolved === null
    )
  );

  const resolvedAgain = await unresolvedIdentityResolver.resolve(actor, "line");

  results.push(
    check(
      "[Test1-2] channelが変わっても常にnull(決定論的)",
      resolvedAgain === null
    )
  );

  return summarize("bot/identityResolver", results);

}
