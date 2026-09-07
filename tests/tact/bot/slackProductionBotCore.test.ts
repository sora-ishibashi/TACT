// =========================
// TACT Bot — Slack Production Bot Core Wiring Regression (S1b)
// =========================
//
// 対象: core/tact-bot/adapters/slack/productionBotCore.tsの
// slackTrustedBotIdentityResolver/slackTrustedBotCoreConnector/
// receiveSlackBotMessageAsTrustedActor()。
//
// 目的(絶対条件Section25): Slack productionのreceiveBotMessage()呼び
// 出しが、BOT-P1の安全なdisconnected default(unresolvedIdentityResolver
// + createNotConnectedCoreConnector())ではなく、実際にSupabase-backed
// 実装(supabaseBotIdentityResolver / createSupabaseConversationBotCore
// Connector())を注入していることを、テキスト比較のような脆い方法では
// なく参照等価性・既存境界の実際の分岐で確認する。
//
// 環境制約: このtest環境にはSUPABASE_SERVICE_ROLE_KEYが設定されて
// いない。そのため、slackTrustedBotCoreConnector/
// receiveSlackBotMessageAsTrustedActorの「実configで呼ぶ」テストは、
// 既存tests/tact/bot/trustedConversationTurn.test.tsと同じ
// 「未設定時は安全にfallbackする」経路だけを確認する(Category A)。
// identity解決済み/Research実行までの詳細な経路は
// tests/tact/bot/slackBotResearchRouting.test.tsがfake dependency
// 経由で検証する。

import "dotenv/config";
import {
  slackTrustedBotIdentityResolver,
  slackTrustedBotCoreConnector,
  receiveSlackBotMessageAsTrustedActor,
} from "../../../core/tact-bot/adapters/slack/productionBotCore";
import { supabaseBotIdentityResolver } from "../../../core/tact-bot/identity/supabaseIdentityResolver";
import { unresolvedIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import type { BotContext, BotIncomingMessage } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMessage(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {
  return {
    channel: "slack",
    actor: { externalUserId: "U123USER" },
    conversation: { externalConversationId: "C123CHANNEL", type: "channel", threadId: "1893456000.000100" },
    organizationId: "T123TEAM",
    messageId: "1893456000.000100",
    text: "OpenAIについて調べて",
    mentionedTact: true,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYが未設定である",
      isServiceRoleConfigured() === false
    )
  );

  // ---- 絶対条件Section25A/C: Slack productionのidentity resolverは
  // 実際にsupabaseBotIdentityResolverそのもの(参照等価)であり、常に
  // nullを返すunresolvedIdentityResolverではない ----
  results.push(
    check(
      "[Section25A] slackTrustedBotIdentityResolver === supabaseBotIdentityResolver(参照等価、disconnected defaultではない)",
      slackTrustedBotIdentityResolver === supabaseBotIdentityResolver
    )
  );

  results.push(
    check(
      "[Section25A] slackTrustedBotIdentityResolver !== unresolvedIdentityResolver",
      (slackTrustedBotIdentityResolver as unknown) !== (unresolvedIdentityResolver as unknown)
    )
  );

  // ---- 絶対条件Section25A/B: coreConnectorは実際にSupabase-backed
  // connector(createSupabaseConversationBotCoreConnector()の生成物)
  // であり、createNotConnectedCoreConnector()ではないことを、
  // 「identity解決済みで呼んだ場合の応答」という既存境界の実際の分岐
  // (conversationConnector.ts固有のtrusted_execution_not_configured
  // 経路、createNotConnectedCoreConnector()には存在しない分岐)で確認
  // する(文言の細かい一致に頼る脆い比較を避ける)。 ----
  {
    const context: BotContext = {
      message: makeMessage(),
      identity: { tactUserId: "fake-tact-user-for-wiring-check" },
      normalizedInput: "OpenAIについて調べて",
    };

    const actions = await slackTrustedBotCoreConnector.handle(context);

    results.push(
      check(
        "[Section25A/B] identity解決済みでslackTrustedBotCoreConnector.handle()を呼ぶと、conversationConnector.ts固有の「TACTとの接続はまだ設定が完了していません」経路(Trusted Bot Execution Boundary未設定時の応答)に到達する——createNotConnectedCoreConnector()の「準備中です」応答とは異なる、実Supabase-backed connectorが配線されている直接証拠",
        actions.length === 1 &&
          actions[0].kind === "reply" &&
          "text" in actions[0] &&
          actions[0].text.includes("設定が完了していません")
      )
    );
  }

  // ---- 絶対条件Section4: このwiring module自体はservice role key/
  // Supabase clientを直接扱わない(呼び出しがエラーにならず、生の
  // credentialを含まない結果を返すことで間接的に確認)。 ----
  {
    const result = await receiveSlackBotMessageAsTrustedActor(makeMessage());

    results.push(
      check(
        "[Section4] receiveSlackBotMessageAsTrustedActor()を実default(supabase-backed)で呼んでも例外を投げず、credential文字列を含まない安全な結果を返す(service role未設定環境のため実DBへは到達しないが、安全にhandled:trueで案内replyを返す)",
        result.handled === true &&
          result.actions.length >= 1 &&
          !JSON.stringify(result).toLowerCase().includes("service_role") &&
          !JSON.stringify(result).includes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "__unset__")
      )
    );
  }

  // ---- DI差し替え: fake identityResolver/coreConnectorへ正しく委譲される ----
  {
    let identityResolveCalls = 0;
    let connectorHandleCalls = 0;

    const result = await receiveSlackBotMessageAsTrustedActor(makeMessage(), {
      identityResolver: {
        async resolve() {
          identityResolveCalls += 1;
          return { tactUserId: "fake-di-user" };
        },
      },
      coreConnector: {
        async handle() {
          connectorHandleCalls += 1;
          return [{ kind: "reply", target: { channel: "slack", conversation: { externalConversationId: "C1", type: "channel" } }, text: "fake-di-response" }];
        },
      },
    });

    results.push(
      check(
        "[DI] identityResolver/coreConnectorを明示的に差し替えた場合、実Supabase-backed実装ではなくfakeが呼ばれる(このwrapper自体がdeps threadingを正しく行っている直接証拠)",
        identityResolveCalls === 1 &&
          connectorHandleCalls === 1 &&
          result.actions[0]?.kind === "reply" &&
          "text" in result.actions[0] &&
          result.actions[0].text === "fake-di-response"
      )
    );
  }

  return summarize("bot/slackProductionBotCore", results);

}
