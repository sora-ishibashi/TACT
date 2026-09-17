// =========================
// TACT Event — Normal Event Flow (EVENT-P1c Section9)
// =========================
//
// EVENT-P1b(ingestExternalEvent())とEVENT-P1c(matchAndClaimExternalEvent
// /resumeClaimedEventWait())を、実際のprovider adapter(EVENT-P1d
// 以降、このphaseでは実装しない)が呼ぶ想定の1つの入口として繋ぐだけの
// 薄いorchestrator。ingest.ts自身にmatching呼び出しを混ぜ込まない
// (EVENT-P1bのモジュール境界——「ingestion」と「matching/resume」は
// 別の関心事——を保つ)。
//
// Section9絶対条件:
//   「P1b returns event_duplicate: load/reconcile the existing event
//   where appropriate. Do not create another ExternalEvent row.」
//   → event_duplicateの場合も、新しいExternalEvent行を作らずに
//     (ingestExternalEvent()自体が既にそれを保証する)、既存行
//     (outcome.existing)のidを使ってmatchAndClaimExternalEvent()を
//     呼ぶ——「前回の配信ではまだwaitが無く、今回waitができていた」
//     というevent-before-waitのreconciliationを、重複配信の度に
//     安全にやり直せるようにする。

import { ingestExternalEvent, type IngestExternalEventDeps } from "./ingest";
import type { EventIngestOutcome, NormalizedExternalEventInput } from "./types";
import { matchAndClaimExternalEvent } from "../tact-work/store";
import type { EventWaitClaimOutcome } from "../tact-work/types";
import { resumeClaimedEventWait, type EventResumeOutcome, type ResumeClaimedEventWaitDeps } from "./resume";

export type ExternalEventArrivalOutcome =
  | {
      status: "processed";
      ingest: EventIngestOutcome;
      match: EventWaitClaimOutcome;
      // matchがwait_claimed以外(event_unmatched/event_ambiguous/
      // wait_expired等)の場合、resumeは一切試みられない。
      resume?: EventResumeOutcome;
    }
  | {
      // ingest自体が失敗した(invalid/wrong_owner/duplicate_conflict/
      // persistence_failed)——マッチングを一切試みない、有効な
      // ExternalEventが存在しないため。
      status: "not_ingested";
      ingest: EventIngestOutcome;
    };

export interface ProcessExternalEventArrivalDeps {

  ingestExternalEvent: (
    input: NormalizedExternalEventInput,
    accessToken: string,
    deps?: IngestExternalEventDeps
  ) => ReturnType<typeof ingestExternalEvent>;

  matchAndClaimExternalEvent: typeof matchAndClaimExternalEvent;

  resumeClaimedEventWait: (
    workId: string,
    taskId: string,
    userId: string,
    accessToken: string,
    eventWaitId: string,
    externalEventId: string,
    deps?: ResumeClaimedEventWaitDeps
  ) => ReturnType<typeof resumeClaimedEventWait>;

}

const defaultProcessExternalEventArrivalDeps: ProcessExternalEventArrivalDeps = {
  ingestExternalEvent,
  matchAndClaimExternalEvent,
  resumeClaimedEventWait,
};

export async function processExternalEventArrival(
  input: NormalizedExternalEventInput,
  accessToken: string,
  deps: ProcessExternalEventArrivalDeps = defaultProcessExternalEventArrivalDeps,
  // EVENT-P1d: only meaningful when accessToken is a service-role
  // connection (e.g. the trusted Slack bridge) — see
  // matchAndClaimExternalEvent() in core/tact-work/store.ts. Ignored by
  // the RPC itself for ordinary user-JWT callers.
  trustedUserId?: string
): Promise<ExternalEventArrivalOutcome> {

  const ingest = await deps.ingestExternalEvent(input, accessToken);

  // Section9: event_received・event_duplicateのいずれも、有効な
  // (永続化済みの)ExternalEvent行を指す——matchingを試みてよい。
  // event_duplicate_conflict/event_invalid/event_wrong_owner/
  // event_persistence_failedはいずれも有効なeventを指さないため、
  // matchingを一切試みない。
  const event = ingest.status === "event_received" ? ingest.event
    : ingest.status === "event_duplicate" ? ingest.existing
    : undefined;

  if (!event) {
    return { status: "not_ingested", ingest };
  }

  const match = await deps.matchAndClaimExternalEvent(accessToken, event.id, trustedUserId);

  if (match.status !== "wait_claimed") {
    return { status: "processed", ingest, match };
  }

  const resume = await deps.resumeClaimedEventWait(
    match.workId,
    match.taskId,
    event.userId,
    accessToken,
    match.waitId,
    match.eventId
  );

  return { status: "processed", ingest, match, resume };

}
