// =========================
// TACT Bot — Trusted External Event Ingest Boundary Regression
// (EVENT-P1d Phase3)
// =========================
//
// 対象: core/tact-bot/execution/trustedExternalEventIngest.ts。
//
// tests/tact/bot/trustedApprovalDecision.test.tsと同じ既存規約:
// 実Supabase接続を一切行わない。getServiceRoleKey/ingestExternalEvent/
// processExternalEventArrivalの3つのdepsだけを偽実装に差し替え、
// この境界自身の責務(credentialの読み出し場所・呼び出し引数の
// 組み立て・trustedUserIdの伝播・生のcredentialを戻り値へ含めない
// こと)だけを検証する。

import {
  ingestTrustedExternalEvent,
  continueTrustedExternalEventArrival,
  type TrustedExternalEventIngestDeps,
  type TrustedExternalEventParams,
} from "../../../core/tact-bot/execution/trustedExternalEventIngest";
import type { EventIngestOutcome, NormalizedExternalEventInput } from "../../../core/tact-event/types";
import type { ExternalEventArrivalOutcome } from "../../../core/tact-event/flow";
import type { ExternalEvent } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const FAKE_SERVICE_ROLE_KEY = "fake-service-role-key-for-test-only";

const SAMPLE_PARAMS: TrustedExternalEventParams = {
  tactUserId: "tact-user-1",
  source: "slack",
  eventType: "app_mention",
  externalEventId: "Ev123",
  subjectRef: "T123:C123:1893456000.000100",
  occurredAt: "2026-09-17T00:00:00.000Z",
  normalizedPayload: { teamId: "T123" },
};

function makeExternalEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: "ext-evt-1",
    userId: "tact-user-1",
    source: "slack",
    eventType: "app_mention",
    externalEventId: "Ev123",
    subjectRef: "T123:C123:1893456000.000100",
    receivedAt: "2026-09-17T00:00:00.000Z",
    normalizedPayload: {},
    status: "received",
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(options: {
  serviceRoleKey?: string;
  ingestOutcome?: EventIngestOutcome;
  arrivalOutcome?: ExternalEventArrivalOutcome;
} = {}): {
  deps: TrustedExternalEventIngestDeps;
  ingestCalls: { input: NormalizedExternalEventInput; accessToken: string }[];
  arrivalCalls: { input: NormalizedExternalEventInput; accessToken: string; trustedUserId?: string }[];
} {

  const ingestCalls: { input: NormalizedExternalEventInput; accessToken: string }[] = [];
  const arrivalCalls: { input: NormalizedExternalEventInput; accessToken: string; trustedUserId?: string }[] = [];

  const deps: TrustedExternalEventIngestDeps = {

    ingestExternalEvent: async (input, accessToken) => {
      ingestCalls.push({ input, accessToken });
      return options.ingestOutcome ?? { status: "event_received", event: makeExternalEvent() };
    },

    processExternalEventArrival: async (input, accessToken, _deps, trustedUserId) => {
      arrivalCalls.push({ input, accessToken, trustedUserId });
      return options.arrivalOutcome ?? { status: "not_ingested", ingest: { status: "event_invalid", reasonCode: "missing_source" } };
    },

    getServiceRoleKey: () => options.serviceRoleKey ?? FAKE_SERVICE_ROLE_KEY,

  };

  return { deps, ingestCalls, arrivalCalls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // ingestTrustedExternalEvent()
  // =========================

  {
    const { deps, ingestCalls } = makeDeps();

    const result = await ingestTrustedExternalEvent(SAMPLE_PARAMS, deps);

    results.push(
      check(
        "[ingestTrustedExternalEvent] service role key設定済み -> ok:true、ingestExternalEvent()へcredentialとNormalizedExternalEventInputを正しく渡す",
        result.ok === true &&
          ingestCalls.length === 1 &&
          ingestCalls[0].accessToken === FAKE_SERVICE_ROLE_KEY &&
          ingestCalls[0].input.userId === "tact-user-1" &&
          ingestCalls[0].input.source === "slack" &&
          ingestCalls[0].input.eventType === "app_mention" &&
          ingestCalls[0].input.externalEventId === "Ev123" &&
          ingestCalls[0].input.subjectRef === "T123:C123:1893456000.000100"
      )
    );

    results.push(
      check(
        "[絶対条件] 生のservice role key文字列が戻り値に一切含まれない",
        !JSON.stringify(result).includes(FAKE_SERVICE_ROLE_KEY)
      )
    );
  }

  {
    const { deps, ingestCalls } = makeDeps({ serviceRoleKey: "" });

    const result = await ingestTrustedExternalEvent(SAMPLE_PARAMS, deps);

    results.push(
      check(
        "[ingestTrustedExternalEvent][絶対条件] service role key未設定 -> DBへ一切アクセスせずtrusted_execution_not_configuredを返す",
        result.ok === false &&
          (result as { error: string }).error === "trusted_execution_not_configured" &&
          ingestCalls.length === 0
      )
    );
  }

  {
    const { deps } = makeDeps({
      ingestOutcome: { status: "event_persistence_failed", error: "connection reset" },
    });

    const result = await ingestTrustedExternalEvent(SAMPLE_PARAMS, deps);

    results.push(
      check(
        "[ingestTrustedExternalEvent] ingestExternalEvent()自体の失敗(event_persistence_failed)は、この境界で握りつぶさずそのまま透過する(呼び出し元がfail-closed 5xxを判断できるように)",
        result.ok === true && (result as { outcome: EventIngestOutcome }).outcome.status === "event_persistence_failed"
      )
    );
  }

  // =========================
  // continueTrustedExternalEventArrival()
  // =========================

  {
    const { deps, arrivalCalls } = makeDeps({
      arrivalOutcome: {
        status: "processed",
        ingest: { status: "event_duplicate", existing: makeExternalEvent() },
        match: { status: "wait_claimed", eventId: "ext-evt-1", waitId: "wait-1", taskId: "task-1", workId: "work-1" },
      },
    });

    const result = await continueTrustedExternalEventArrival(SAMPLE_PARAMS, deps);

    results.push(
      check(
        "[continueTrustedExternalEventArrival] service role keyをaccessTokenとして、tactUserIdをtrustedUserIdとしてprocessExternalEventArrival()へ渡す",
        result.ok === true &&
          arrivalCalls.length === 1 &&
          arrivalCalls[0].accessToken === FAKE_SERVICE_ROLE_KEY &&
          arrivalCalls[0].trustedUserId === "tact-user-1" &&
          arrivalCalls[0].input.externalEventId === "Ev123"
      )
    );

    results.push(
      check(
        "[continueTrustedExternalEventArrival] processExternalEventArrival()の結果(match/resumeを含む)をそのまま透過する(match/resumeを手で再実装しない)",
        result.ok === true &&
          (result as { outcome: ExternalEventArrivalOutcome }).outcome.status === "processed" &&
          "match" in (result as { outcome: ExternalEventArrivalOutcome }).outcome &&
          ((result as { outcome: Extract<ExternalEventArrivalOutcome, { status: "processed" }> }).outcome.match.status === "wait_claimed")
      )
    );
  }

  {
    const { deps, arrivalCalls } = makeDeps({ serviceRoleKey: undefined as unknown as string });

    const result = await continueTrustedExternalEventArrival(SAMPLE_PARAMS, {
      ...deps,
      getServiceRoleKey: () => "",
    });

    results.push(
      check(
        "[continueTrustedExternalEventArrival][絶対条件] service role key未設定 -> DBへ一切アクセスせずtrusted_execution_not_configuredを返す",
        result.ok === false &&
          (result as { error: string }).error === "trusted_execution_not_configured" &&
          arrivalCalls.length === 0
      )
    );
  }

  return summarize("bot/trustedExternalEventIngest", results);

}
