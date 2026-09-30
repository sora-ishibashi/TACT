// =========================
// TACT Canonical Execution — Slack Web API Call Adapter Regression (SOR-130)
// =========================
//
// 対象: core/tact-execution/adapters/slack/normalizeSlackWebApiCallExecution.ts
// のnormalizeSlackWebApiInvocationToExecution()(純粋関数、DBアクセス
// なし)。既存のnormalizeSlackExecutionEvent.ts(reconciled/inbound)とは
// 逆方向の、instrumented/outboundなSlack呼び出し(chat.postMessage等)を
// 扱う新規adapterのmock-based regression。

import { normalizeSlackWebApiInvocationToExecution } from "../../../../core/tact-execution/adapters/slack/normalizeSlackWebApiCallExecution";

import { check, summarize, type CheckResult } from "../../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: AUTH_TEST -> read/slack_auth_test/slack_workspace ----
  {
    const result = normalizeSlackWebApiInvocationToExecution({
      userId: "user-1",
      invocationId: "inv-auth-1",
      operation: "AUTH_TEST",
      botUserId: "UBOT1",
      teamId: "T1",
      status: "succeeded",
    });

    results.push(check("[Test1] AUTH_TESTはok=trueを返す", result.ok === true));

    if (result.ok) {
      results.push(
        check(
          "[Test1] provider='slack'、actionCategory='read'、resourceType='slack_workspace'に正規化される",
          result.input.provider === "slack" &&
            result.input.actionCategory === "read" &&
            result.input.operation === "slack_auth_test" &&
            result.input.resourceType === "slack_workspace" &&
            result.input.resourceIdentifier === "T1"
        )
      );

      results.push(
        check(
          "[Test1] principal(bot自身)がactorIdとして伝播する。actorKind='service'",
          result.input.actorKind === "service" && result.input.actorId === "UBOT1"
        )
      );

      results.push(
        check(
          "[Test1] observationMode='instrumented'(既存のreconciledなinbound adapterとは異なる経路)",
          result.input.observationMode === "instrumented"
        )
      );
    }
  }

  // ---- Test2: CHAT_POST_MESSAGE -> send/slack_chat_post_message/slack_message ----
  {
    const result = normalizeSlackWebApiInvocationToExecution({
      userId: "user-1",
      invocationId: "inv-post-1",
      operation: "CHAT_POST_MESSAGE",
      teamId: "T1",
      channel: "C123",
      messageTs: "1790000001.000200",
      status: "succeeded",
    });

    results.push(
      check(
        "[Test2] CHAT_POST_MESSAGEはactionCategory='send'に写像され、resourceIdentifierはteam:channel:tsになる",
        result.ok === true &&
          result.input.actionCategory === "send" &&
          result.input.operation === "slack_chat_post_message" &&
          result.input.resourceType === "slack_message" &&
          result.input.resourceIdentifier === "T1:C123:1790000001.000200"
      )
    );

    results.push(
      check(
        "[Test2] message本文はsourceMetadataへ一切含まれない(teamId/channelのみ)",
        result.ok === true &&
          JSON.stringify(result.input.sourceMetadata ?? {}) === JSON.stringify({ teamId: "T1", channel: "C123" })
      )
    );
  }

  // ---- Test3: 失敗時はsafe error codeへ丸められる ----
  {
    const result = normalizeSlackWebApiInvocationToExecution({
      userId: "user-1",
      invocationId: "inv-fail-1",
      operation: "CHAT_POST_MESSAGE",
      teamId: "T1",
      channel: "C-DOES-NOT-EXIST",
      status: "failed",
      errorCode: "slack_channel_not_found",
    });

    results.push(
      check(
        "[Test3] 失敗時はallow-listされたerrorCodeのみ保持し、errorMessageは固定文言",
        result.ok === true &&
          result.input.status === "failed" &&
          result.input.errorCode === "slack_channel_not_found" &&
          result.input.errorMessage === "Slack Web API call failed"
      )
    );
  }

  // ---- Test4: invocationId欠落はok=false ----
  {
    const result = normalizeSlackWebApiInvocationToExecution({
      userId: "user-1",
      invocationId: "",
      operation: "AUTH_TEST",
      status: "succeeded",
    });

    results.push(check("[Test4] invocationId欠落時はok=falseを返す", result.ok === false));
  }

  // ---- Test5: workIdはlegitimateなcarrierが無ければnull ----
  {
    const result = normalizeSlackWebApiInvocationToExecution({
      userId: "user-1",
      invocationId: "inv-nowk-1",
      operation: "AUTH_TEST",
      status: "succeeded",
    });

    results.push(
      check(
        "[Test5] workId省略時はnull(fake claimを作らない、UNASSIGNEDとして正しく扱う)",
        result.ok === true && result.input.workId === null
      )
    );
  }

  return summarize("SOR-130 — Slack Web API Call Adapter", results);

}
