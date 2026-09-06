// =========================
// TACT Integration — Pure Mapping/Normalization Regression
// (Architecture Migration Phase C1)
// =========================
//
// 対象: core/tact-integration/connection.tsのtoConnection()(DB row↔
// domain変換)、core/tact-integration/providers/composio/mappings/
// slack.tsのmapSlackActionToComposioTool()、core/tact-integration/
// providers/composio/adapter.tsのnormalizeComposioError()。いずれも
// 純粋関数でDBアクセス・実Composio API呼び出みは一切発生しない。

import { toConnection, type ConnectionRow } from "../../../core/tact-integration/connection";
import { mapSlackActionToComposioTool } from "../../../core/tact-integration/providers/composio/mappings/slack";
import { normalizeComposioError } from "../../../core/tact-integration/providers/composio/adapter";
import {
  ComposioConnectedAccountNotFoundError,
  ComposioToolNotFoundError,
  ComposioToolVersionRequiredError,
  ComposioToolExecutionError,
  ComposioSharedAccessDeniedError,
  ComposioError,
} from "@composio/core";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // toConnection()
  // =========================

  {
    const row: ConnectionRow = {
      id: "conn-1",
      user_id: "user-1",
      service: "slack",
      status: "active",
      provider: "composio",
      provider_connection_ref: "ca_slack_123",
      metadata: { rawStatus: "ACTIVE" },
      created_at: "2026-09-07T00:00:00.000Z",
      updated_at: "2026-09-07T00:00:00.000Z",
    };

    const connection = toConnection(row);

    results.push(
      check(
        "[toConnection] 基本フィールドがsnake_case -> camelCaseへ変換される",
        connection.id === "conn-1" &&
          connection.userId === "user-1" &&
          connection.providerConnectionRef === "ca_slack_123"
      )
    );

    results.push(
      check(
        "[toConnection] credential/token相当のfieldがDomain型に一切存在しない(絶対条件)",
        !("token" in connection) &&
          !("accessToken" in connection) &&
          !("refreshToken" in connection) &&
          !("secret" in connection)
      )
    );
  }

  // =========================
  // mapSlackActionToComposioTool()
  // =========================

  {
    const mapped = mapSlackActionToComposioTool({
      service: "slack",
      operation: "send_message",
      input: { channel: "#general", text: "こんにちは" },
    });

    results.push(
      check(
        "[Slack mapping] send_message -> SLACK_SEND_MESSAGE(現行slug、deprecated版は使わない)",
        mapped.ok === true && mapped.invocation.slug === "SLACK_SEND_MESSAGE"
      )
    );

    results.push(
      check(
        "[Slack mapping] channelはそのまま、textはComposio側の実schema(markdown_text)へ変換されてargumentsに渡る(Phase C1.5 Live Acceptanceで実機確認)",
        mapped.ok === true &&
          mapped.invocation.arguments.channel === "#general" &&
          mapped.invocation.arguments.markdown_text === "こんにちは" &&
          !("text" in mapped.invocation.arguments)
      )
    );
  }

  {
    const mapped = mapSlackActionToComposioTool({
      service: "slack",
      operation: "delete_message",
      input: { channel: "#general" },
    });

    results.push(
      check(
        "[Slack mapping] 未対応operationは安全にok:falseを返す(例外を投げない)",
        mapped.ok === false
      )
    );
  }

  {
    const mapped = mapSlackActionToComposioTool({
      service: "slack",
      operation: "send_message",
      input: { channel: "", text: "" },
    });

    results.push(
      check(
        "[Slack mapping] channel/textが空文字の場合はok:falseを返す",
        mapped.ok === false
      )
    );
  }

  {
    const mapped = mapSlackActionToComposioTool({
      // @ts-expect-error -- 意図的に未対応serviceを渡す防御的テスト
      service: "gmail",
      operation: "send_message",
      input: {},
    });

    results.push(
      check(
        "[Slack mapping] service!=='slack'は安全にok:falseを返す",
        mapped.ok === false
      )
    );
  }

  // =========================
  // normalizeComposioError()
  // =========================

  {
    const normalized = normalizeComposioError(new ComposioConnectedAccountNotFoundError());

    results.push(
      check(
        "[Error normalize] ComposioConnectedAccountNotFoundError -> connection_missing",
        normalized.code === "connection_missing" && normalized.retryable === false
      )
    );
  }

  {
    const normalized = normalizeComposioError(new ComposioSharedAccessDeniedError());

    results.push(
      check(
        "[Error normalize] ComposioSharedAccessDeniedError -> authorization_denied",
        normalized.code === "authorization_denied"
      )
    );
  }

  {
    const normalized = normalizeComposioError(new ComposioToolNotFoundError());

    results.push(
      check(
        "[Error normalize] ComposioToolNotFoundError -> invalid_action",
        normalized.code === "invalid_action"
      )
    );
  }

  {
    const normalized = normalizeComposioError(new ComposioToolVersionRequiredError());

    results.push(
      check(
        "[Error normalize] ComposioToolVersionRequiredError -> invalid_action",
        normalized.code === "invalid_action"
      )
    );
  }

  {
    const normalized = normalizeComposioError(new ComposioToolExecutionError());

    results.push(
      check(
        "[Error normalize] ComposioToolExecutionError -> provider_execution_failed",
        normalized.code === "provider_execution_failed"
      )
    );
  }

  {
    const normalized = normalizeComposioError(new ComposioError("unexpected"));

    results.push(
      check(
        "[Error normalize] その他のComposioError -> provider_execution_failedへ安全にfallback",
        normalized.code === "provider_execution_failed"
      )
    );
  }

  {
    const normalized = normalizeComposioError(new Error("network boom"));

    results.push(
      check(
        "[Error normalize] Composioエラーですらない例外も安全にnormalizeされる(例外を再throwしない)",
        normalized.code === "provider_execution_failed" && normalized.message === "network boom"
      )
    );
  }

  {
    const allCodes = [
      normalizeComposioError(new ComposioConnectedAccountNotFoundError()),
      normalizeComposioError(new ComposioSharedAccessDeniedError()),
      normalizeComposioError(new ComposioToolNotFoundError()),
      normalizeComposioError(new ComposioToolExecutionError()),
      normalizeComposioError(new Error("x")),
    ];

    results.push(
      check(
        "[Error normalize] Phase C1絶対条件(Section20): いかなるエラーもretryable=trueにならない(安全側)",
        allCodes.every((e) => e.retryable === false)
      )
    );
  }

  return summarize("integration/mapping", results);

}
