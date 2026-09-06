// =========================
// TACT Integration — Composio Client Safe-Fallback Regression
// (Architecture Migration Phase C1)
// =========================
//
// 対象: core/tact-integration/providers/composio/client.tsの
// isComposioConfigured()、および同ディレクトリのcomposioIntegration
// Provider.execute()・createSlackConnectionLink()・
// getSlackConnectionStatus()の「未設定時の安全なfallback」経路。
//
// 環境制約(core/tact-bot/execution/trustedConversationTurn.test.ts
// と同じ既存方針): このtest実行環境では通常COMPOSIO_API_KEYが設定
// されていない(Phase C1時点の既定状態)。そのため、ここではmockを
// 使わず実関数をそのまま呼び出し、「未設定時は一切実Composio APIへ
// アクセスせず安全にfallbackする」という分岐だけを確認する
// (Category A、pure/deterministic)。「設定済み」経路(実Composio呼び
// 出し)はここではテストしない——live acceptance testは別途、実
// credential入手後に実施する(Phase C1.5で実施済み)。
//
// Precondition guard(Phase C1.5 Live Acceptanceで発見・追加):
// Live Acceptance session等、実行環境に実COMPOSIO_API_KEYが設定されて
// いる場合、isComposioConfigured()がtrueになりcomposioIntegration
// Provider.execute()等が実際にComposio clientを構築してしまうため、
// 以下の「未設定時fallback」検証はそもそも成立しない(実APIへ到達
// する・存在しないconnectedAccountIdに対する404が未catchで例外化する
// おそれがある)。「CI/unit testsで実Composio APIを叩かない」という
// 絶対条件を守るため、設定済みの場合はここで安全にskipし、以降の
// 実API呼び出しを一切行わない。credential非漏洩自体の検証は
// normalizeComposioError()の純粋関数test(tests/tact/integration/
// mapping.test.ts)で引き続き担保されており、この分岐は無効化しない。

import "dotenv/config";
import { isComposioConfigured } from "../../../core/tact-integration/providers/composio/client";
import { composioIntegrationProvider } from "../../../core/tact-integration/providers/composio/adapter";
import {
  isSlackAuthConfigured,
  createSlackConnectionLink,
  getSlackConnectionStatus,
} from "../../../core/tact-integration/providers/composio/connectionLink";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  if (isComposioConfigured()) {

    results.push(
      check(
        "[Precondition guard] COMPOSIO_API_KEYが設定されている環境のため、このfile本来の「未設定時fallback」検証は成立しない。実Composio APIへは一切アクセスせず安全にskipする(credential非漏洩の検証はtests/tact/integration/mapping.test.tsのnormalizeComposioError()テストで別途担保済み)",
        true
      )
    );

    return summarize("integration/composioClient", results);

  }

  results.push(
    check(
      "[Precondition] このtest環境ではCOMPOSIO_API_KEYが未設定である(設定済みの場合、以下のtestは実APIアクセスを試みてしまうため、前提条件として確認する)",
      isComposioConfigured() === false
    )
  );

  const executeResult = await composioIntegrationProvider.execute({
    userId: "user-1",
    workId: "work-1",
    connectionId: "conn-1",
    providerConnectionRef: "ca_slack_123",
    action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } },
  });

  results.push(
    check(
      "[未設定fallback] composioIntegrationProvider.execute() -> status=failed・code=authentication_error(実APIへ一切アクセスしない)",
      executeResult.status === "failed" && executeResult.error.code === "authentication_error"
    )
  );

  results.push(
    check(
      "[未設定fallback] エラーメッセージにAPI key等の生Credentialが含まれない",
      executeResult.status === "failed" &&
        !JSON.stringify(executeResult).toLowerCase().includes("bearer") &&
        !JSON.stringify(executeResult).includes(process.env.COMPOSIO_API_KEY ?? "__unset__")
    )
  );

  results.push(
    check(
      "[Precondition] このtest環境ではCOMPOSIO_SLACK_AUTH_CONFIG_IDも未設定である",
      isSlackAuthConfigured() === false
    )
  );

  const linkResult = await createSlackConnectionLink("user-1");

  results.push(
    check(
      "[未設定fallback] createSlackConnectionLink() -> null(実Composio API呼び出しをしない)",
      linkResult === null
    )
  );

  const statusResult = await getSlackConnectionStatus("ca_slack_123");

  results.push(
    check(
      "[未設定fallback] getSlackConnectionStatus() -> null(実Composio API呼び出しをしない)",
      statusResult === null
    )
  );

  return summarize("integration/composioClient", results);

}
