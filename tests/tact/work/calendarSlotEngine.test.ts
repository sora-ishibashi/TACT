import { normalizeBusyIntervals } from "../../../core/tact-work/calendarAvailability";
import { generateCandidateSlots, CANDIDATE_SLOT_GRANULARITY_MINUTES } from "../../../core/tact-work/slotEngine";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c: deterministic busy-interval normalization + slot generation.
// No timezone here is anything other than an explicit function argument —
// this suite deliberately exercises more than one zone (Asia/Tokyo and
// America/New_York, which observes DST) to confirm nothing is hardcoded to
// a single offset.

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // normalizeBusyIntervals
  // =========================

  const overlapping = normalizeBusyIntervals(
    [
      { startUtc: "2026-09-14T01:00:00.000Z", endUtc: "2026-09-14T02:00:00.000Z" },
      { startUtc: "2026-09-14T01:30:00.000Z", endUtc: "2026-09-14T02:30:00.000Z" },
    ],
    "2026-09-14T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z"
  );
  results.push(check(
    "[normalize] overlapping intervals merge into one",
    overlapping.length === 1 && overlapping[0].startUtc === "2026-09-14T01:00:00.000Z" && overlapping[0].endUtc === "2026-09-14T02:30:00.000Z"
  ));

  const nested = normalizeBusyIntervals(
    [
      { startUtc: "2026-09-14T01:00:00.000Z", endUtc: "2026-09-14T05:00:00.000Z" },
      { startUtc: "2026-09-14T02:00:00.000Z", endUtc: "2026-09-14T03:00:00.000Z" },
    ],
    "2026-09-14T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z"
  );
  results.push(check(
    "[normalize] a nested interval collapses into the outer one",
    nested.length === 1 && nested[0].startUtc === "2026-09-14T01:00:00.000Z" && nested[0].endUtc === "2026-09-14T05:00:00.000Z"
  ));

  const touching = normalizeBusyIntervals(
    [
      { startUtc: "2026-09-14T01:00:00.000Z", endUtc: "2026-09-14T02:00:00.000Z" },
      { startUtc: "2026-09-14T02:00:00.000Z", endUtc: "2026-09-14T03:00:00.000Z" },
    ],
    "2026-09-14T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z"
  );
  results.push(check(
    "[normalize] touching intervals merge into one continuous block",
    touching.length === 1 && touching[0].endUtc === "2026-09-14T03:00:00.000Z"
  ));

  const clipped = normalizeBusyIntervals(
    [{ startUtc: "2026-09-13T20:00:00.000Z", endUtc: "2026-09-14T04:00:00.000Z" }],
    "2026-09-14T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z"
  );
  results.push(check(
    "[normalize] an interval extending outside the range is clipped to it",
    clipped.length === 1 && clipped[0].startUtc === "2026-09-14T00:00:00.000Z" && clipped[0].endUtc === "2026-09-14T04:00:00.000Z"
  ));

  const malformed = normalizeBusyIntervals(
    [
      { startUtc: "not-a-date", endUtc: "2026-09-14T02:00:00.000Z" },
      { startUtc: "2026-09-14T05:00:00.000Z", endUtc: "2026-09-14T04:00:00.000Z" }, // inverted
      { startUtc: "2026-09-14T06:00:00.000Z", endUtc: "2026-09-14T07:00:00.000Z" },
    ],
    "2026-09-14T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z"
  );
  results.push(check(
    "[normalize] malformed/inverted intervals are dropped, not fabricated as busy",
    malformed.length === 1 && malformed[0].startUtc === "2026-09-14T06:00:00.000Z"
  ));

  // =========================
  // generateCandidateSlots — Asia/Tokyo (UTC+9, no DST)
  // =========================

  const tokyoRange = {
    rangeStartUtc: "2026-09-13T15:00:00.000Z", // 2026-09-14T00:00 JST
    rangeEndUtc: "2026-09-15T15:00:00.000Z", // 2026-09-16T00:00 JST (2 local days)
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 9 * 60, endMinuteOfDay: 18 * 60 },
  };

  const openSlots = generateCandidateSlots({
    ...tokyoRange,
    durationMinutes: 30,
    busyIntervals: [],
    candidateCount: 3,
  });
  results.push(check(
    "[slots] an open window with no busy intervals returns exactly the requested count, 15-minute aligned",
    openSlots.length === 3 &&
      openSlots[0].startUtc === "2026-09-14T00:00:00.000Z" && // 09:00 JST
      openSlots[1].startUtc === "2026-09-14T00:15:00.000Z" &&
      openSlots[2].startUtc === "2026-09-14T00:30:00.000Z" &&
      openSlots.every((slot) => slot.timezone === "Asia/Tokyo")
  ));
  results.push(check(
    "[slots] candidate indices are stable, 1-based presentation order",
    openSlots.map((slot) => slot.index).join(",") === "1,2,3"
  ));

  const blockedStart = generateCandidateSlots({
    ...tokyoRange,
    durationMinutes: 30,
    busyIntervals: [{ startUtc: "2026-09-14T00:00:00.000Z", endUtc: "2026-09-14T00:30:00.000Z" }], // 09:00-09:30 JST busy
    candidateCount: 1,
  });
  results.push(check(
    "[slots] a slot overlapping a busy interval is skipped, and the exact boundary right after it is allowed",
    blockedStart.length === 1 && blockedStart[0].startUtc === "2026-09-14T00:30:00.000Z"
  ));

  const allDayBusy = generateCandidateSlots({
    ...tokyoRange,
    durationMinutes: 30,
    busyIntervals: [{ startUtc: "2026-09-13T15:00:00.000Z", endUtc: "2026-09-14T15:00:00.000Z" }], // all of day 1
    candidateCount: 1,
  });
  results.push(check(
    "[slots] an all-day busy event blocks every slot for that day and rolls over to the next day",
    allDayBusy.length === 1 && allDayBusy[0].startUtc === "2026-09-15T00:00:00.000Z" // 09:00 JST day 2
  ));

  const insufficientTime = generateCandidateSlots({
    rangeStartUtc: "2026-09-13T15:00:00.000Z",
    rangeEndUtc: "2026-09-14T15:00:00.000Z", // only 1 local day
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 9 * 60, endMinuteOfDay: 9 * 60 + 20 }, // a 20-minute window
    durationMinutes: 30, // does not fit
    busyIntervals: [],
    candidateCount: 3,
  });
  results.push(check(
    "[slots] insufficient free time yields fewer candidates than requested, never fabricated ones",
    insufficientTime.length === 0
  ));

  const cappedByCount = generateCandidateSlots({
    ...tokyoRange,
    durationMinutes: 15,
    busyIntervals: [],
    candidateCount: 2,
  });
  results.push(check(
    "[slots] candidate count is respected even when far more free slots exist",
    cappedByCount.length === 2
  ));

  const determinism = generateCandidateSlots({ ...tokyoRange, durationMinutes: 30, busyIntervals: [], candidateCount: 3 });
  results.push(check(
    "[slots] re-generating from the same inputs never silently mutates the result",
    JSON.stringify(determinism) === JSON.stringify(openSlots)
  ));

  // =========================
  // A different offset (America/New_York, observes DST) — proves nothing
  // is hardcoded to Asia/Tokyo.
  // =========================

  const nySlots = generateCandidateSlots({
    rangeStartUtc: "2026-09-14T00:00:00.000Z",
    rangeEndUtc: "2026-09-15T00:00:00.000Z",
    timezone: "America/New_York", // UTC-4 in September (EDT)
    dailyWindow: { startMinuteOfDay: 9 * 60, endMinuteOfDay: 18 * 60 },
    durationMinutes: 30,
    busyIntervals: [],
    candidateCount: 1,
  });
  results.push(check(
    "[slots] a different IANA timezone offset resolves to a different, correct UTC instant",
    nySlots.length === 1 && nySlots[0].startUtc === "2026-09-14T13:00:00.000Z" // 09:00 EDT = 13:00 UTC
  ));

  // =========================
  // A daily window that crosses local midnight (endMinuteOfDay >= 1440)
  // =========================
  //
  // TIME-P1c HARDENING (Blocker B): a range starting inside the carry-over
  // portion of the PREVIOUS local day's overnight window must include that
  // carry-over — the scan now seeds one local day before rangeStart's own
  // day for exactly this reason. Where a range starts exactly at a local
  // day's midnight (as it does here), that midnight instant sits inside the
  // tail of the previous day's 22:00-02:00 window, so the correct first
  // candidate is the earliest point in that carry-over (00:00 local),
  // not the next full 22:00 window.

  const crossMidnightWindow = generateCandidateSlots({
    rangeStartUtc: "2026-09-13T15:00:00.000Z", // 2026-09-14T00:00 JST
    rangeEndUtc: "2026-09-16T15:00:00.000Z", // 2026-09-17T00:00 JST
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 22 * 60, endMinuteOfDay: 26 * 60 }, // 22:00-02:00 next day
    durationMinutes: 30,
    busyIntervals: [],
    candidateCount: 100,
  });
  results.push(check(
    "[slots HARDENING Blocker B] a range starting exactly at local midnight includes the previous day's overnight carry-over as the first candidate",
    crossMidnightWindow[0]?.startUtc === "2026-09-13T15:00:00.000Z" // 00:00 JST (carry-over tail of the prior day's 22:00-02:00 window)
  ));
  results.push(check(
    "[slots HARDENING Blocker B] the carry-over window still clips correctly at its own 02:00 local end",
    crossMidnightWindow.some((slot) => slot.startUtc === "2026-09-13T16:30:00.000Z") && // 01:30 JST, last 30-min slot fitting before 02:00
      !crossMidnightWindow.some((slot) => slot.startUtc === "2026-09-13T16:45:00.000Z") // would end at 02:15 JST, past the window
  ));
  results.push(check(
    "[slots] a full (non-carry-over) overnight window on a later day still starts at the right instant (granularity: " + CANDIDATE_SLOT_GRANULARITY_MINUTES + "min)",
    crossMidnightWindow.some((slot) => slot.startUtc === "2026-09-14T13:00:00.000Z") // 22:00 JST day1 = 13:00 UTC
  ));
  results.push(check(
    "[slots] a daily window spanning local midnight ends at the right instant, not at local midnight (regression: end-of-window overflow minutes were previously dropped)",
    crossMidnightWindow.some((slot) => slot.startUtc === "2026-09-14T16:30:00.000Z") && // last slot fitting before 02:00 JST
      !crossMidnightWindow.some((slot) => slot.startUtc === "2026-09-14T16:45:00.000Z") // would end at 02:15 JST, past the window
  ));

  // Required test: "requested range starting 00:30 includes prior-day
  // carry-over" — a range that starts mid-carry-over (not at a clean
  // midnight boundary) must offer that exact grid-aligned instant.
  const rangeStartsMidCarryOver = generateCandidateSlots({
    rangeStartUtc: "2026-09-13T15:30:00.000Z", // 2026-09-14T00:30 JST — 30 min into the carry-over
    rangeEndUtc: "2026-09-16T15:00:00.000Z",
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 22 * 60, endMinuteOfDay: 26 * 60 },
    durationMinutes: 30,
    busyIntervals: [],
    candidateCount: 1,
  });
  results.push(check(
    "[slots HARDENING Blocker B] a range starting at 00:30 (mid carry-over, already grid-aligned) offers exactly that instant",
    rangeStartsMidCarryOver[0]?.startUtc === "2026-09-13T15:30:00.000Z"
  ));

  // Required test: a narrow 23:45-00:15 overnight window.
  const narrowOvernightWindow = generateCandidateSlots({
    rangeStartUtc: "2026-09-13T14:45:00.000Z", // 2026-09-13T23:45 JST
    rangeEndUtc: "2026-09-15T15:00:00.000Z",
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 23 * 60 + 45, endMinuteOfDay: 24 * 60 + 15 }, // 23:45-00:15
    durationMinutes: 15,
    busyIntervals: [],
    candidateCount: 2,
  });
  results.push(check(
    "[slots] a narrow 23:45-00:15 overnight window offers exactly its two 15-minute-fitting starts (23:45 and 00:00)",
    narrowOvernightWindow.length === 2 &&
      narrowOvernightWindow[0].startUtc === "2026-09-13T14:45:00.000Z" && // 23:45 JST
      narrowOvernightWindow[1].startUtc === "2026-09-13T15:00:00.000Z" // 00:00 JST
  ));

  const crossMidnightBusy = generateCandidateSlots({
    rangeStartUtc: "2026-09-13T15:00:00.000Z",
    rangeEndUtc: "2026-09-16T15:00:00.000Z",
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 0, endMinuteOfDay: 1440 }, // full day, both local days in range
    durationMinutes: 30,
    // Busy 23:00 JST day1 -> 01:00 JST day2, crossing the local-midnight
    // boundary between the two independent per-day loop iterations.
    busyIntervals: [{ startUtc: "2026-09-14T14:00:00.000Z", endUtc: "2026-09-14T16:00:00.000Z" }],
    candidateCount: 200,
  });
  const withinCrossMidnightBusy = crossMidnightBusy.some(
    (slot) => slot.startUtc >= "2026-09-14T14:00:00.000Z" && slot.startUtc < "2026-09-14T16:00:00.000Z"
  );
  results.push(check(
    "[slots] a busy interval crossing local midnight blocks candidates spanning both calendar-day iterations",
    !withinCrossMidnightBusy && crossMidnightBusy.some((slot) => slot.startUtc === "2026-09-14T16:00:00.000Z")
  ));

  // =========================
  // Grid alignment (TIME-P1c HARDENING, Blocker A)
  // =========================

  const gridBase = {
    rangeEndUtc: "2026-09-15T15:00:00.000Z",
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 9 * 60, endMinuteOfDay: 18 * 60 },
    durationMinutes: 30,
    busyIntervals: [],
    candidateCount: 1,
  };

  const gridSevenPast = generateCandidateSlots({ ...gridBase, rangeStartUtc: "2026-09-14T00:07:00.000Z" }); // 09:07 JST
  results.push(check(
    "[slots HARDENING Blocker A] 09:07 rounds up to the next 15-minute grid boundary, 09:15",
    gridSevenPast[0]?.startUtc === "2026-09-14T00:15:00.000Z" // 09:15 JST
  ));

  const gridAlreadyAligned = generateCandidateSlots({ ...gridBase, rangeStartUtc: "2026-09-14T00:15:00.000Z" }); // 09:15 JST exactly
  results.push(check(
    "[slots HARDENING Blocker A] an already grid-aligned 09:15 start remains 09:15, unchanged",
    gridAlreadyAligned[0]?.startUtc === "2026-09-14T00:15:00.000Z"
  ));

  const gridFiftyNine = generateCandidateSlots({ ...gridBase, rangeStartUtc: "2026-09-14T00:59:00.000Z" }); // 09:59 JST
  results.push(check(
    "[slots HARDENING Blocker A] 09:59 rounds up across the hour boundary to 10:00",
    gridFiftyNine[0]?.startUtc === "2026-09-14T01:00:00.000Z" // 10:00 JST
  ));

  const gridExactBoundaryAtNine = generateCandidateSlots({ ...gridBase, rangeStartUtc: "2026-09-14T00:00:00.000Z" }); // 09:00 JST exactly
  results.push(check(
    "[slots HARDENING Blocker A] an exact 09:00 boundary remains 09:00",
    gridExactBoundaryAtNine[0]?.startUtc === "2026-09-14T00:00:00.000Z"
  ));

  const gridAfterBusyBoundary = generateCandidateSlots({
    ...gridBase,
    rangeStartUtc: "2026-09-14T00:00:00.000Z",
    busyIntervals: [{ startUtc: "2026-09-14T00:00:00.000Z", endUtc: "2026-09-14T00:45:00.000Z" }], // 09:00-09:45 JST busy
  });
  results.push(check(
    "[slots HARDENING Blocker A] the exact grid-aligned boundary immediately after a busy interval is still offered, never skipped",
    gridAfterBusyBoundary[0]?.startUtc === "2026-09-14T00:45:00.000Z" // 09:45 JST, exactly busy.end, grid-aligned
  ));

  return summarize("work/calendarSlotEngine", results);
}
