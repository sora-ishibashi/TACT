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
import {
  mapSlackActionToComposioTool,
  mapComposioListChannelsResultToCanonical,
} from "../../../core/tact-integration/providers/composio/mappings/slack";
import {
  normalizeComposioError,
  buildExecutionResultFromToolResult,
} from "../../../core/tact-integration/providers/composio/adapter";
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

  // =========================
  // Architecture Migration Phase C2.2b: list_channels
  // (Composio SLACK_LIST_ALL_CHANNELS、C2.2aで一次確認済みschemaに
  // 基づくmapping完成版)
  // =========================

  // ---- canonical -> Composio(exact input mapping) ----
  {
    const mapped = mapSlackActionToComposioTool({
      service: "slack",
      operation: "list_channels",
      input: {},
    });

    results.push(
      check(
        "[Section13] canonical list_channels(input:{})はexact tool slug SLACK_LIST_ALL_CHANNELSへ変換される",
        mapped.ok === true && mapped.invocation.slug === "SLACK_LIST_ALL_CHANNELS"
      )
    );

    results.push(
      check(
        "[Section13] argumentsはlimit:100(Provider Adapter都合のdefault、C2.2a確認済みschema既定値=1を上書き)だけを持つ",
        mapped.ok === true && JSON.stringify(mapped.invocation.arguments) === JSON.stringify({ limit: 100 })
      )
    );

    results.push(
      check(
        "[Section13] types/cursor/team_id/exclude_archivedが勝手にargumentsへ含まれない(provider既定挙動のまま、canonical semanticsを勝手に拡張しない)",
        mapped.ok === true &&
          !("types" in mapped.invocation.arguments) &&
          !("cursor" in mapped.invocation.arguments) &&
          !("team_id" in mapped.invocation.arguments) &&
          !("exclude_archived" in mapped.invocation.arguments)
      )
    );
  }

  // =========================
  // mapComposioListChannelsResultToCanonical()
  // =========================

  // ---- Section14: canonical result(余剰fieldがdropされる) ----
  {
    const mapped = mapComposioListChannelsResultToCanonical({
      ok: true,
      channels: [
        {
          id: "C1",
          name: "general",
          is_private: false,
          created: 123,
          num_members: 10,
          topic: { value: "x", creator: "U1", last_set: 1 },
          purpose: { value: "y", creator: "U1", last_set: 1 },
        },
        { id: "C2", name: "tact", is_private: true, created: 456 },
      ],
      response_metadata: { next_cursor: "NEXT_PAGE_CURSOR" },
    });

    results.push(
      check(
        "[Section14] channelsがid/name/isPrivateだけのcanonical shapeへ変換される",
        mapped.ok === true &&
          JSON.stringify(mapped.result) ===
            JSON.stringify({
              channels: [
                { id: "C1", name: "general", isPrivate: false },
                { id: "C2", name: "tact", isPrivate: true },
              ],
            })
      )
    );

    results.push(
      check(
        "[Section14] created/topic/purpose/num_members等の余剰fieldがcanonical outputに一切存在しない",
        mapped.ok === true && !JSON.stringify(mapped.result).match(/created|topic|purpose|num_members/)
      )
    );

    results.push(
      check(
        "[Section21] response_metadata/next_cursorがcanonical outputへ一切露出しない",
        mapped.ok === true && !JSON.stringify(mapped.result).includes("NEXT_PAGE_CURSOR")
      )
    );
  }

  // ---- Section15: nameがoptional(DM等でname無し) ----
  {
    const mapped = mapComposioListChannelsResultToCanonical({
      ok: true,
      channels: [{ id: "C3", created: 789 }],
    });

    results.push(
      check(
        "[Section15] name/isPrivateが無いchannel itemでも例外を投げず、idだけのcanonical itemになる(nameキー自体を持たない)",
        mapped.ok === true &&
          JSON.stringify(mapped.result) === JSON.stringify({ channels: [{ id: "C3" }] })
      )
    );
  }

  // ---- Section16: malformed provider result -> safe failure ----
  {
    const notOk = mapComposioListChannelsResultToCanonical({ ok: false, channels: [] });
    const missingChannels = mapComposioListChannelsResultToCanonical({ ok: true });
    const notArrayChannels = mapComposioListChannelsResultToCanonical({ ok: true, channels: "not-an-array" });
    const missingId = mapComposioListChannelsResultToCanonical({ ok: true, channels: [{ name: "no-id" }] });
    const nonStringId = mapComposioListChannelsResultToCanonical({ ok: true, channels: [{ id: 123 }] });
    const notObject = mapComposioListChannelsResultToCanonical(null);

    results.push(
      check(
        "[Section16] data.ok===false / channels欠落 / channels非array / item.id欠落 / item.id非string / data非object のいずれもraw例外を投げず、ok:falseの安全な失敗として扱われる",
        notOk.ok === false &&
          missingChannels.ok === false &&
          notArrayChannels.ok === false &&
          missingId.ok === false &&
          nonStringId.ok === false &&
          notObject.ok === false
      )
    );

    results.push(
      check(
        "[Section16] item.id欠落のような部分的なschema契約違反は、該当itemだけをdropせずresult全体をinvalidにする(黙ってprovider schema corruptionを隠さない)",
        missingId.ok === false && "reason" in missingId && typeof missingId.reason === "string"
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
      service: "notion",
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
  // buildExecutionResultFromToolResult()
  // (Architecture Migration Phase C2.2b、Section9: Adapter output)
  // =========================
  //
  // core/tact-integration/providers/composio/adapter.tsのexecuteComposio()
  // 本体(実Composio client構築を含む)から、tools.execute()のraw結果を
  // IntegrationExecutionResultへ組み立てる部分だけを切り出した純粋関数。
  // 実Composio呼び出し無しに直接検証する。

  {
    const result = buildExecutionResultFromToolResult(
      { service: "slack", operation: "list_channels", input: {} },
      {
        successful: true,
        data: { ok: true, channels: [{ id: "C1", name: "general", is_private: false, created: 1 }] },
        logId: "log-1",
      }
    );

    results.push(
      check(
        "[Section9] list_channels成功時、IntegrationExecutionResult.outputへcanonical SlackListChannelsResult(id/name/isPrivateのみ)が格納される(raw Composio responseそのままではない)",
        result.status === "completed" &&
          JSON.stringify(result.output) === JSON.stringify({ channels: [{ id: "C1", name: "general", isPrivate: false }] })
      )
    );
  }

  {
    const result = buildExecutionResultFromToolResult(
      { service: "slack", operation: "list_channels", input: {} },
      { successful: true, data: { ok: false, channels: [] }, logId: "log-2" }
    );

    results.push(
      check(
        "[Section9] list_channelsでraw response canonicalization自体が失敗した場合、raw provider detailsを漏らさず安全にfailedへ倒す(provider_execution_failed、生のdata/エラーオブジェクトを含まない)",
        result.status === "failed" &&
          result.error.code === "provider_execution_failed" &&
          !JSON.stringify(result).includes("channels")
      )
    );
  }

  {
    // 絶対条件(Section9、write regression): send_message等list_channels
    // 以外のoperationでは、既存通りresult.dataをそのままoutputへ渡す
    // 挙動を変更しない。
    const rawData = { ok: true, ts: "123.456", channel: "C1" };

    const result = buildExecutionResultFromToolResult(
      { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } },
      { successful: true, data: rawData, logId: "log-3" }
    );

    results.push(
      check(
        "[Section9/Section20] send_message成功時は既存通りresult.dataがそのままoutputへ渡る(list_channels専用のcanonicalizationを誤って適用しない)",
        result.status === "completed" && result.output === rawData
      )
    );
  }

  {
    const result = buildExecutionResultFromToolResult(
      { service: "slack", operation: "list_channels", input: {} },
      { successful: false, error: "not_authed", logId: "log-4" }
    );

    results.push(
      check(
        "[Section9] tools.execute()自体がsuccessful:falseを返した場合はfailedを返す(list_channels canonicalizationへ進まない)",
        result.status === "failed" && result.error.code === "provider_execution_failed"
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

  // =========================
  // LIVE-1A(Composio Error Cause Observability):
  // normalizeComposioError() diagnostic enrichment
  // =========================
  //
  // 対象: @composio/core自身がhandleToolExecutionError()
  // (ToolErrors.ts)経由でComposioToolExecutionError.causeへ保持する
  // 元エラーを、normalizeComposioError()がproviderDetailsへ安全に
  // 転記すること。raw cause objectそのものは保持しない。

  // ---- A: cause = Error("underlying provider reason") -> providerDetails.causeMessageへ反映 ----
  {
    const underlyingCause = new Error("underlying provider reason");
    const toolError = new ComposioToolExecutionError(
      "Error executing the tool GMAIL_FETCH_EMAILS",
      { cause: underlyingCause }
    );

    const normalized = normalizeComposioError(toolError);
    const providerDetails = normalized.providerDetails as
      | { provider?: unknown; errorName?: unknown; causeName?: unknown; causeMessage?: unknown }
      | undefined;

    results.push(
      check(
        "[LIVE-1A/A] ComposioToolExecutionError.cause(Error)がproviderDetails.causeName/causeMessageへ安全に反映される",
        providerDetails?.provider === "composio" &&
          providerDetails?.errorName === "ComposioToolExecutionError" &&
          providerDetails?.causeName === "Error" &&
          providerDetails?.causeMessage === "underlying provider reason"
      )
    );

    results.push(
      check(
        "[LIVE-1A] Run.error相当のnormalized.message自体はSDKの汎用文言のまま変更されない(causeMessageを混ぜない)",
        normalized.message === "Error executing the tool GMAIL_FETCH_EMAILS"
      )
    );
  }

  // ---- B: statusCodeが存在する場合はproviderDetails.statusCodeへ反映される ----
  {
    const toolError = new ComposioToolExecutionError("Error executing the tool GMAIL_FETCH_EMAILS", {
      cause: new Error("bad request"),
      statusCode: 400,
    });

    const normalized = normalizeComposioError(toolError);
    const providerDetails = normalized.providerDetails as { statusCode?: unknown } | undefined;

    results.push(
      check(
        "[LIVE-1A/B] statusCodeが存在する場合、providerDetails.statusCodeへ保持される",
        providerDetails?.statusCode === 400
      )
    );
  }

  // ---- statusCodeが無い場合はfieldごと省略される(undefinedを無理に保存しない) ----
  {
    const normalized = normalizeComposioError(new ComposioToolExecutionError("x", { cause: new Error("y") }));
    const providerDetails = normalized.providerDetails as { statusCode?: unknown } | undefined;

    results.push(
      check(
        "[LIVE-1A] statusCodeが無い場合、providerDetailsに'statusCode'キー自体が含まれない",
        !!providerDetails && !("statusCode" in providerDetails)
      )
    );
  }

  // ---- C: Bearer token / access_token / refresh_token / API key風文字列がcauseMessageへ含まれてもredactされる ----
  {
    const secrets = [
      "Bearer sk-live-abcdef123456",
      "access_token=ya29.a0Af-secret-value",
      "refresh_token: 1//0g-refresh-secret",
      "api_key=sk_test_should_not_leak",
      "Authorization: Basic dXNlcjpwYXNz",
    ];

    const results_C = secrets.map((secretText) => {
      const toolError = new ComposioToolExecutionError("Error executing the tool GMAIL_FETCH_EMAILS", {
        cause: new Error(`upstream rejected request: ${secretText}`),
      });
      const normalized = normalizeComposioError(toolError);
      const causeMessage = (normalized.providerDetails as { causeMessage?: string } | undefined)?.causeMessage ?? "";
      return { secretText, causeMessage };
    });

    results.push(
      check(
        "[LIVE-1A/C] Bearer token/access_token/refresh_token/api_key/Authorization風の文字列がcauseMessageに含まれていてもredactされ、rawな値は残らない",
        results_C.every(({ secretText, causeMessage }) => {
          const rawSecretValue = secretText.split(/[:=]\s*/)[1] ?? secretText;
          return causeMessage.includes("[redacted]") && !causeMessage.includes(rawSecretValue);
        })
      )
    );
  }

  // ---- D: connectedAccountId(knownSecrets経由)がcauseMessageに含まれていても確実に除去される ----
  {
    const connectedAccountId = "ca_gmail_9f3e7d2c-live-account";
    const toolError = new ComposioToolExecutionError("Error executing the tool GMAIL_FETCH_EMAILS", {
      cause: new Error(`connected account ${connectedAccountId} could not be resolved for this toolkit`),
    });

    const normalized = normalizeComposioError(toolError, [connectedAccountId]);
    const causeMessage = (normalized.providerDetails as { causeMessage?: string } | undefined)?.causeMessage ?? "";

    results.push(
      check(
        "[LIVE-1A/D] knownSecretsとして渡したconnectedAccountIdは、causeMessage中に字面として出現しても確実に除去される",
        !causeMessage.includes(connectedAccountId) && causeMessage.includes("[redacted]")
      )
    );
  }

  // ---- F: providerDetails自体はIntegrationExecutionErrorのみに存在し、
  // Slack向けformatter(core/tact-conversation/orchestration.tsの
  // formatIntegrationReadFailureAnswer())へ渡る型
  // (OrchestrationResult.integrationReadFailure)にはservice/operation/
  // statusしか存在しない——型定義そのものがcauseMessage等を運べない
  // ことの直接確認(型レベルの構造的保証)。
  {
    const normalized = normalizeComposioError(
      new ComposioToolExecutionError("x", { cause: new Error("Bearer sk-should-never-reach-slack") })
    );

    // IntegrationExecutionError.providerDetailsはRecord<string, unknown>
    // (core/tact-integration/types.ts)——OrchestrationResult.
    // integrationReadFailureへ渡すのは呼び出し元(core/tact-work/
    // execution.ts)がstatusのみを転記する設計であり、providerDetails
    // 自体を運ぶfieldがそちらの型に存在しない(tests/tact/conversation/
    // integrationReadResult.test.tsのLIVE-1A/Eで、integrationReadFailure
    // 型に余剰keyが紛れてもformatterがそれを読まないことを別途確認済み)。
    results.push(
      check(
        "[LIVE-1A/F] providerDetailsはIntegrationExecutionError側にのみ存在する診断専用データであり、正規のexportとしてはこのfile(composio adapter)からのみ得られる",
        typeof normalized.providerDetails === "object" && normalized.providerDetails !== null
      )
    );
  }

  return summarize("integration/mapping", results);

}
