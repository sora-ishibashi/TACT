// =========================
// TACT Canonical Execution — Slack Adapter Regression (SOR-50)
// =========================
//
// 対象: core/tact-execution/adapters/slack/normalizeSlackExecutionEvent.ts
// のnormalizeSlackAppMentionEventToExecution()(純粋関数、DBアクセス
// なし)。SOR-50が要求する「1種類の実Adapterでvertical sliceが通る」
// ことを、実Slack app_mention event envelopeの形をした入力で証明する。

import { normalizeSlackAppMentionEventToExecution } from "@tact/runs-core/tact-execution/adapters/slack/normalizeSlackExecutionEvent";
import type { ExecutionAdapterContext } from "@tact/runs-core/tact-execution/adapters/types";
import { check, summarize, type CheckResult } from "../../lib/check";

const context: ExecutionAdapterContext = {
  userId: "user-1",
  observedAt: "2026-09-20T00:00:01.000Z",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常なapp_mention envelope -> CaptureExecutionInput ----
  {
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

    const result = normalizeSlackAppMentionEventToExecution(envelope, context);

    results.push(check("[Test1] 正常なapp_mention eventはok=trueを返す", result.ok === true));

    if (result.ok) {

      results.push(
        check(
          "[Test1] provider/sourceType/externalEventIdが正しく正規化される",
          result.input.provider === "slack" &&
            result.input.sourceType === "webhook" &&
            result.input.externalEventId === "Ev123"
        )
      );

      results.push(
        check(
          "[Test1] actorはhuman/Slack user IDとして正規化される",
          result.input.actorKind === "human" && result.input.actorId === "U123"
        )
      );

      results.push(
        check(
          "[Test1] action分類(create/app_mention/slack_message)が正規化される。resourceIdentifierはteam_id(workspace識別子)を含む(SOR-52 Closeout Hardening Part8、workspace collision防止)",
          result.input.actionCategory === "create" &&
            result.input.operation === "app_mention" &&
            result.input.resourceType === "slack_message" &&
            result.input.resourceIdentifier === "T1:C1:1790000000.000100"
        )
      );

      results.push(
        check(
          "[Test1] message本文(text)はsourceMetadataへ含まれない(Provenanceの安全性要件)。teamIdは含まれる",
          JSON.stringify(result.input.sourceMetadata ?? {}).includes("教えて") === false &&
            (result.input.sourceMetadata as Record<string, unknown> | null)?.teamId === "T1"
        )
      );

      results.push(
        check(
          "[Test1] providerOccurredAtはevent_time(unix秒)からISO変換される",
          result.input.providerOccurredAt === new Date(1790000000 * 1000).toISOString()
        )
      );

    }

  }

  // ---- Test2: event_idが無い -> ok=false(idempotencyが成立しない) ----
  {
    const envelope = {
      type: "event_callback",
      event: { type: "app_mention", user: "U123", ts: "1.1", channel: "C1" },
    };

    const result = normalizeSlackAppMentionEventToExecution(envelope, context);

    results.push(
      check("[Test2] event_id欠落時はok=falseを返す(idempotency keyが成立しない)", result.ok === false)
    );
  }

  // ---- Test3: app_mention以外のevent種別 -> ok=false ----
  {
    const envelope = {
      type: "event_callback",
      event_id: "Ev999",
      event: { type: "message", user: "U123", ts: "1.1", channel: "C1" },
    };

    const result = normalizeSlackAppMentionEventToExecution(envelope, context);

    results.push(check("[Test3] app_mention以外のevent種別はok=falseを返す", result.ok === false));
  }

  // ---- Test4: event_callback以外のenvelope種別 -> ok=false ----
  {
    const result = normalizeSlackAppMentionEventToExecution({ type: "url_verification" }, context);

    results.push(check("[Test4] event_callback以外のenvelopeはok=falseを返す", result.ok === false));
  }

  // ---- Test5: workId/connectionId等のcontextがそのまま伝播する ----
  {
    const envelope = {
      type: "event_callback",
      event_id: "Ev123",
      event: { type: "app_mention", user: "U123", ts: "1.1", channel: "C1" },
    };

    const result = normalizeSlackAppMentionEventToExecution(envelope, {
      ...context,
      workId: "work-1",
      organizationId: "org-1",
    });

    results.push(
      check(
        "[Test5] AdapterContextのworkId/organizationIdがCaptureExecutionInputへ伝播する",
        result.ok === true && result.input.workId === "work-1" && result.input.organizationId === "org-1"
      )
    );
  }

  // ---- Test19: 同じchannel/timestampでも異なるteam(workspace)なら
  // resource identityが衝突しない(SOR-52 Closeout Hardening Part8) ----
  {
    const makeEnvelope = (teamId: string) => ({
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev-${teamId}`,
      event: { type: "app_mention", user: "U123", ts: "1790000000.000100", channel: "C1" },
    });

    const resultA = normalizeSlackAppMentionEventToExecution(makeEnvelope("T-WORKSPACE-A"), context);
    const resultB = normalizeSlackAppMentionEventToExecution(makeEnvelope("T-WORKSPACE-B"), context);

    results.push(
      check(
        "[Test19] 同じchannel/message timestampでもteam_idが異なればresourceIdentifierは異なる(workspace collision回避)",
        resultA.ok === true &&
          resultB.ok === true &&
          resultA.ok &&
          resultB.ok &&
          resultA.input.resourceIdentifier !== resultB.input.resourceIdentifier &&
          resultA.input.resourceIdentifier === "T-WORKSPACE-A:C1:1790000000.000100" &&
          resultB.input.resourceIdentifier === "T-WORKSPACE-B:C1:1790000000.000100"
      )
    );
  }

  return summarize("TACT Canonical Execution — Slack Adapter", results);

}
