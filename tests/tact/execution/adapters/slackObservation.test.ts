// =========================
// TACT Canonical Execution — Slack Observation Regression (SOR-129)
// =========================
//
// 対象: core/tact-execution/adapters/slack/observeSlackAppMentionExecution.ts。
// 実際のSlack app_mention envelope(tests/tact/execution/adapters/
// slackAdapter.test.tsで既に検証済みのfixtureと同じshape)がnormalize→
// Generic Observation Gatewayを経由して、captureExecution()まで正しく
// 到達することを確認する——Notion以外のproviderからもGatewayが同じ形で
// 呼び出せることの実証(「Slack接続結果」)。本番webhook route
// (handleSlackWebhookRequest.ts)への配線はこのfileの対象外
// (observeSlackAppMentionExecution.tsの既存コメント参照)。

import { observeSlackAppMentionExecution } from "@tact/runs-core/tact-execution/adapters/slack/observeSlackAppMentionExecution";
import type { ObserveCanonicalExecutionDeps } from "@tact/runs-core/tact-execution/gateway/types";
import type { CanonicalExecution, CaptureExecutionInput } from "@tact/runs-core/tact-execution/types";
import type { ExecutionAdapterContext } from "@tact/runs-core/tact-execution/adapters/types";
import { check, summarize, type CheckResult } from "../../lib/check";

const context: ExecutionAdapterContext = {
  userId: "user-1",
  observedAt: "2026-09-20T00:00:01.000Z",
};

const envelope = {
  type: "event_callback",
  team_id: "T1",
  event_id: "Ev123",
  event_time: 1790000000,
  event: {
    type: "app_mention",
    user: "U123",
    text: "<@BOT> 教えて",
    ts: "1790000000.000100",
    channel: "C1",
  },
};

function noopPermission(): ObserveCanonicalExecutionDeps["observeExecutionPermission"] {
  return async () => ({ status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" });
}

function noopCorrelation(): ObserveCanonicalExecutionDeps["observeExecutionWorkCorrelation"] {
  return async () => ({ status: "persisted" as const, decision: {} as never });
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 実際のSlack app_mention envelopeがGateway経由でcaptureExecution()まで届く ----
  {
    let capturedInput: CaptureExecutionInput | undefined;
    const failures: string[] = [];

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async (input) => {
        capturedInput = input;
        return {
          status: "captured",
          execution: { permissionStatus: "unknown" } as CanonicalExecution,
        };
      },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };

    await observeSlackAppMentionExecution(envelope, context, deps);

    results.push(
      check(
        "[Test1] Slack app_mention envelopeはnormalize失敗せず、captureExecution()まで到達する(失敗0件)",
        failures.length === 0 && capturedInput !== undefined
      )
    );

    results.push(
      check(
        "[Test1] captureExecution()へ渡されるinputのprovider='slack'、userId=context.userId",
        capturedInput?.provider === "slack" && capturedInput?.userId === "user-1"
      )
    );
  }

  // ---- Test2: 未対応のenvelope形状はstage='normalization'で隔離され、captureExecution()は呼ばれない ----
  {
    let captureCalled = false;
    const failures: string[] = [];

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => {
        captureCalled = true;
        return { status: "captured", execution: { permissionStatus: "unknown" } as CanonicalExecution };
      },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };

    await observeSlackAppMentionExecution({ type: "url_verification" }, context, deps);

    results.push(
      check(
        "[Test2] 未対応のSlack envelope形状はstage='normalization'で隔離され、captureExecutionは呼ばれない",
        failures.length === 1 && failures[0] === "normalization" && !captureCalled
      )
    );
  }

  // ---- Test3: capture失敗もGateway経由でNotionと同じ隔離方式になる(provider間の一貫性) ----
  {
    const failures: string[] = [];

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => { throw new Error("database unavailable"); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };

    await observeSlackAppMentionExecution(envelope, context, deps);

    results.push(
      check(
        "[Test3] captureExecution()の例外はSlackでもstage='capture'として隔離される(Notionと同一のGateway契約)",
        failures.length === 1 && failures[0] === "capture"
      )
    );
  }

  return summarize("SOR-129 — Slack Observation (Generic Gateway経由)", results);

}
