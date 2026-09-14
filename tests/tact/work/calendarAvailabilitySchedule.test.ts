import { resolveTemporalDateRange } from "../../../core/tact-work/temporalRange";
import {
  generateCandidateSchedule,
  extractTimezoneAnswer,
  extractDailyWindowAnswer,
  toCandidateSlotSnapshotMetadata,
  readCandidateSlotSnapshotMetadata,
} from "../../../core/tact-work/candidateSchedule";
import { createFakeCalendarAvailabilityProvider } from "../../../core/tact-work/calendarAvailability";
import { CANDIDATE_SLOT_GRANULARITY_MINUTES } from "../../../core/tact-work/slotEngine";
import type { TemporalRequirement } from "../../../core/tact-work/temporalRequirements";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c: TemporalRequirement -> concrete range -> provider READ -> slot
// engine -> candidate result, plus the Section 26 Reality Test (fake
// provider, no live Calendar access — see core/tact-work/calendarAvailability.ts).

const REFERENCE = "2026-09-14T00:00:00.000Z"; // Monday 09:00 JST

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // resolveTemporalDateRange — relative expressions require an explicit
  // reference instant + timezone; no server/process time is ever consulted.
  // =========================

  const noTimezone = resolveTemporalDateRange({ kind: "relative", value: "next_week" }, REFERENCE, undefined);
  results.push(check(
    "[range] no timezone means no silent resolution",
    !noTimezone.success && noTimezone.code === "timezone_missing"
  ));

  const unrecognizedTimezone = resolveTemporalDateRange({ kind: "relative", value: "today" }, REFERENCE, "Mars/Nonexistent");
  results.push(check(
    "[range] an unrecognized timezone name fails closed rather than guessing",
    !unrecognizedTimezone.success && unrecognizedTimezone.code === "timezone_unrecognized"
  ));

  const noDate = resolveTemporalDateRange(undefined, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] a missing date constraint is incomplete, not silently defaulted",
    !noDate.success && noDate.code === "temporal_requirement_incomplete"
  ));

  const nextWeek = resolveTemporalDateRange({ kind: "relative", value: "next_week" }, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] 来週 resolves to the upcoming Mon-Sun week, only once timezone+reference are explicit",
    nextWeek.success && nextWeek.range.startUtc === "2026-09-20T15:00:00.000Z" && nextWeek.range.endUtc === "2026-09-27T15:00:00.000Z"
  ));
  results.push(check(
    "[range] provenance preserves the original semantic constraint alongside the resolved range",
    nextWeek.success && nextWeek.range.resolvedFrom.kind === "relative" && (nextWeek.range.resolvedFrom as { value: string }).value === "next_week"
  ));

  const thisWeek = resolveTemporalDateRange({ kind: "relative", value: "this_week" }, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] 今週 runs from today through the end of the current week",
    thisWeek.success && thisWeek.range.startUtc === "2026-09-13T15:00:00.000Z" && thisWeek.range.endUtc === "2026-09-20T15:00:00.000Z"
  ));

  const friday = resolveTemporalDateRange({ kind: "relative", value: "friday" }, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] 金曜 resolves to the single upcoming Friday",
    friday.success && friday.range.startUtc === "2026-09-17T15:00:00.000Z" && friday.range.endUtc === "2026-09-18T15:00:00.000Z"
  ));

  const pastNoYearDate = resolveTemporalDateRange({ kind: "date", date: "09-10" }, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] a no-year date already passed this year rolls to next year, never into the past",
    pastNoYearDate.success && pastNoYearDate.range.startUtc.startsWith("2027-09-")
  ));

  const malformedYearedDate = resolveTemporalDateRange({ kind: "date", date: "202609-14" }, REFERENCE, "Asia/Tokyo");
  results.push(check(
    "[range] TIME-P1b's pre-existing malformed yeared-date shape fails closed rather than misinterpreting it",
    !malformedYearedDate.success && malformedYearedDate.code === "temporal_requirement_incomplete"
  ));

  // =========================
  // Clarification-answer parsers — never inferred from the original
  // request text, only from a direct answer.
  // =========================

  results.push(check("[answer] an exact IANA identifier is accepted", extractTimezoneAnswer("Asia/Tokyo") === "Asia/Tokyo"));
  results.push(check("[answer] a city name or abbreviation is not guessed into a timezone", extractTimezoneAnswer("東京") === undefined && extractTimezoneAnswer("JST") === undefined));
  results.push(check(
    "[answer] a daily window answer parses start/end minutes",
    JSON.stringify(extractDailyWindowAnswer("9:00〜18:00")) === JSON.stringify({ startMinuteOfDay: 540, endMinuteOfDay: 1080 })
  ));
  results.push(check("[answer] a nonsensical window (end before start) is rejected", extractDailyWindowAnswer("18:00〜9:00") === undefined));

  // =========================
  // generateCandidateSchedule — error taxonomy (Section 21: these must stay
  // distinguishable, never collapsed into one generic failure).
  // =========================

  const provider = createFakeCalendarAvailabilityProvider({});
  const baseRequirement: TemporalRequirement = {
    durationMinutes: 30,
    date: { kind: "relative", value: "next_week" },
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 540, endMinuteOfDay: 1080 },
    candidateCount: 3,
  };

  const missingTimezone = await generateCandidateSchedule({
    requirement: { ...baseRequirement, timezone: undefined },
    referenceInstantUtc: REFERENCE,
    provider,
  });
  results.push(check("[schedule] missing timezone is distinguished as its own error", !missingTimezone.success && missingTimezone.error.code === "timezone_missing"));

  const missingWindow = await generateCandidateSchedule({
    requirement: { ...baseRequirement, dailyWindow: undefined },
    referenceInstantUtc: REFERENCE,
    provider,
  });
  results.push(check("[schedule] missing daily window is distinguished as its own error (no hidden business-hours default)", !missingWindow.success && missingWindow.error.code === "daily_window_missing"));

  const missingDuration = await generateCandidateSchedule({
    requirement: { ...baseRequirement, durationMinutes: undefined },
    referenceInstantUtc: REFERENCE,
    provider,
  });
  results.push(check("[schedule] missing duration is incomplete, distinguished from a missing timezone/window", !missingDuration.success && missingDuration.error.code === "temporal_requirement_incomplete"));

  const connectionMissing = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({ error: { code: "connection_missing", message: "no connection" } }),
  });
  results.push(check("[schedule] a missing Calendar connection is distinguished from other provider errors", !connectionMissing.success && connectionMissing.error.code === "connection_missing"));

  const permissionDenied = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({ error: { code: "permission_denied", message: "no scope" } }),
  });
  results.push(check("[schedule] a provider permission error is distinguished", !permissionDenied.success && permissionDenied.error.code === "permission_denied"));

  const providerFailure = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({ error: { code: "provider_failure", message: "timeout" } }),
  });
  results.push(check("[schedule] a provider failure is distinguished from \"no availability\"", !providerFailure.success && providerFailure.error.code === "provider_failure"));

  const malformedResponse = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({ respondWithMalformedResult: true }),
  });
  results.push(check("[schedule] a malformed provider response is distinguished, not silently treated as free/busy", !malformedResponse.success && malformedResponse.error.code === "malformed_response"));

  const noAvailability = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({
      busyIntervals: [{ startUtc: "2026-09-20T15:00:00.000Z", endUtc: "2026-09-27T15:00:00.000Z" }], // busy for the whole resolved range
    }),
  });
  results.push(check("[schedule] a fully-booked range is \"no_availability\", distinguished from a provider failure", !noAvailability.success && noAvailability.error.code === "no_availability"));

  // =========================
  // TIME-P1c HARDENING (Blocker F): provider-neutral fail-closed
  // validation. These use bypassNormalization so the Fake provider returns
  // hostile data exactly as given, without sanitizing it first — proving
  // candidateSchedule.ts's own independent validation catches it, not just
  // the provider's own good behavior.
  // =========================

  const malformedInterval = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({
      bypassNormalization: true,
      busyIntervals: [{ startUtc: "not-a-real-timestamp", endUtc: "2026-09-21T01:00:00.000Z" }],
    }),
  });
  results.push(check(
    "[schedule HARDENING Blocker F] a malformed provider busy interval fails the WHOLE result as malformed_response, never silently dropped to create false availability",
    !malformedInterval.success && malformedInterval.error.code === "malformed_response"
  ));

  const reversedInterval = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({
      bypassNormalization: true,
      busyIntervals: [{ startUtc: "2026-09-21T02:00:00.000Z", endUtc: "2026-09-21T01:00:00.000Z" }], // end before start
    }),
  });
  results.push(check(
    "[schedule HARDENING Blocker F] a reversed (end-before-start) busy interval fails the whole result, never treated as zero-duration-and-ignorable",
    !reversedInterval.success && reversedInterval.error.code === "malformed_response"
  ));

  const invalidSourceScope = await generateCandidateSchedule({
    requirement: baseRequirement,
    referenceInstantUtc: REFERENCE,
    provider: createFakeCalendarAvailabilityProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately constructing a runtime-invalid sourceScope the compile-time union forbids, to prove runtime validation doesn't just trust the type
      sourceScope: "attendee_calendar" as any,
    }),
  });
  results.push(check(
    "[schedule HARDENING Blocker F] an unsupported sourceScope is rejected at runtime, never trusted just because TypeScript's type says it's fine",
    !invalidSourceScope.success && invalidSourceScope.error.code === "malformed_response"
  ));

  // Hostile Reality case (Section 15): a DST-invalid temporal request, run
  // through the full generateCandidateSchedule() pipeline (not just
  // resolveTemporalDateRange() directly — see work/temporalHardening.test.ts
  // for that lower-level coverage). America/Santiago's 2026-09-06 00:00
  // local midnight is a real, verified DST spring-forward gap.
  const dstInvalidRequest = await generateCandidateSchedule({
    requirement: { ...baseRequirement, date: { kind: "date", date: "2026-09-06" }, timezone: "America/Santiago" },
    referenceInstantUtc: "2026-09-01T00:00:00Z",
    provider: createFakeCalendarAvailabilityProvider({}),
  });
  results.push(check(
    "[schedule HARDENING Blocker D hostile case] a requested date whose local midnight is a real DST gap fails closed end-to-end, never fabricating a range or candidates",
    !dstInvalidRequest.success && dstInvalidRequest.error.code === "dst_invalid_local_time"
  ));

  // =========================
  // Reality Test (Section 26): "来週、30分の打ち合わせ候補を3つ出して",
  // given an explicit reference time, explicit timezone, and fake busy
  // intervals — end to end, deterministic, no provider write, no Approval.
  // =========================

  const realityRequirement: TemporalRequirement = {
    durationMinutes: 30,
    date: { kind: "relative", value: "next_week" },
    candidateCount: 3,
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 540, endMinuteOfDay: 1080 }, // 9:00-18:00
  };
  const realityProvider = createFakeCalendarAvailabilityProvider({
    busyIntervals: [
      { startUtc: "2026-09-21T00:00:00.000Z", endUtc: "2026-09-21T01:00:00.000Z" }, // 09:00-10:00 JST Mon 9/21
    ],
  });

  const reality = await generateCandidateSchedule({
    requirement: realityRequirement,
    referenceInstantUtc: REFERENCE,
    provider: realityProvider,
  });

  results.push(check(
    "[reality] the end-to-end pipeline produces exactly 3 deterministic candidates outside the busy window",
    reality.success &&
      reality.candidates.length === 3 &&
      reality.candidates.every((slot) => !(slot.startUtc >= "2026-09-21T00:00:00.000Z" && slot.startUtc < "2026-09-21T01:00:00.000Z")) &&
      reality.candidates[0].startUtc === "2026-09-21T01:00:00.000Z" && // first free slot right after the busy interval
      reality.sourceScope === "own_calendar"
  ));

  // =========================
  // Candidate snapshot pinning (Section 19) round-trips through the same
  // metadata shape Work.metadata would persist.
  // =========================

  if (reality.success) {
    const snapshot = toCandidateSlotSnapshotMetadata({
      candidates: reality.candidates,
      generatedAtUtc: REFERENCE,
      sourceScope: "own_calendar",
      resolvedRange: { startUtc: reality.resolvedRange.startUtc, endUtc: reality.resolvedRange.endUtc },
      timezone: realityRequirement.timezone!,
      dailyWindow: realityRequirement.dailyWindow!,
      candidateCount: realityRequirement.candidateCount!,
      slotGranularityMinutes: CANDIDATE_SLOT_GRANULARITY_MINUTES,
    });
    const roundTripped = readCandidateSlotSnapshotMetadata({ unrelatedKey: "kept", calendarCandidateSnapshot: snapshot });
    results.push(check(
      "[snapshot] a generated candidate set round-trips through Work.metadata with stable indices",
      roundTripped !== undefined &&
        roundTripped.candidates.map((c) => c.index).join(",") === "1,2,3" &&
        roundTripped.candidates[0].startUtc === reality.candidates[0].startUtc
    ));
  } else {
    results.push(check("[snapshot] a generated candidate set round-trips through Work.metadata with stable indices", false, "reality generation itself failed"));
  }

  results.push(check(
    "[snapshot] a malformed/foreign metadata value is rejected rather than trusted blindly",
    readCandidateSlotSnapshotMetadata({ calendarCandidateSnapshot: { version: 2 } }) === undefined &&
      readCandidateSlotSnapshotMetadata({}) === undefined
  ));

  // =========================
  // Source-level safety assertions (Section 22/24: read-only, no write, no
  // Approval anywhere in this phase's new files) — same technique already
  // used by tests/tact/work/temporalRequirements.test.ts.
  // =========================

  const newFiles = [
    "calendarAvailability.ts",
    "slotEngine.ts",
    "temporalRange.ts",
    "candidateSchedule.ts",
    "timezone.ts",
  ].map((name) => readFileSync(join(__dirname, "..", "..", "..", "core", "tact-work", name), "utf8"));

  const forbiddenWritePatterns = [
    "insertEvent", "updateEvent", "deleteEvent", "events.insert", "events.update", "events.delete",
    "requestApproval(", "createApproval(",
  ];
  const hasForbiddenPattern = newFiles.some((source) => forbiddenWritePatterns.some((pattern) => source.includes(pattern)));
  results.push(check("[safety] no Calendar write call and no Approval creation exist anywhere in the new TIME-P1c files", !hasForbiddenPattern));

  const usesServerLocalTime = newFiles.some((source) => source.includes("getTimezoneOffset") || /new Date\(\)(?!\.)/.test(source));
  results.push(check("[safety] no file reads the server/process local timezone or an implicit \"now\"", !usesServerLocalTime));

  return summarize("work/calendarAvailabilitySchedule", results);
}
