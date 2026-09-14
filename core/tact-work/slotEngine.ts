// TACT Work — TIME-P1c: deterministic candidate slot generation.
//
// Absolute condition (Section 11): this is pure arithmetic over instants.
// No LLM call, no randomness, no server/process time — every input is
// explicit (resolved range, timezone, busy intervals already normalized by
// calendarAvailability.ts, daily search window, candidate count).
//
// Product decisions this file encodes (confirmed by the user before
// implementation, since no existing repository default covered them):
//   - slot granularity: 15-minute grid (CANDIDATE_SLOT_GRANULARITY_MINUTES)
//   - default candidate count when unspecified: 3 (DEFAULT_CANDIDATE_COUNT)
//   - daily business-hours window: NO built-in default. There is no
//     "09:00-18:00" constant anywhere in this file — the caller
//     (candidateSchedule.ts) must supply an explicit DailyWindow, sourced
//     from the user's own temporal requirement, or ask a Clarification
//     first. This file will happily search a 24-hour day if given one; it
//     enforces no business-hours opinion of its own.

import type { BusyInterval } from "./calendarAvailability";
import { getZonedParts, zonedWallTimeToUtcMs } from "./timezone";

export const CANDIDATE_SLOT_GRANULARITY_MINUTES = 15;
export const DEFAULT_CANDIDATE_COUNT = 3;

export interface CandidateSlot {
  // 1-based presentation order (Section 18) — stable within one generation
  // call, used later to resolve "2番で" against the pinned snapshot
  // (Section 19), never recomputed independently of the snapshot it came
  // from.
  readonly index: number;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly timezone: string;
}

export interface DailyWindow {
  // Minutes since local midnight, in the request's timezone.
  // [startMinuteOfDay, endMinuteOfDay). 1440 means local midnight of the
  // next day (a full day).
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
}

export interface SlotEngineInput {
  readonly rangeStartUtc: string;
  readonly rangeEndUtc: string;
  readonly timezone: string;
  readonly durationMinutes: number;
  // Already normalized (clipped/sorted/merged) by
  // calendarAvailability.ts's normalizeBusyIntervals(). This function does
  // not re-merge — it only checks overlap against each given interval.
  readonly busyIntervals: readonly BusyInterval[];
  readonly dailyWindow: DailyWindow;
  readonly candidateCount: number;
  readonly granularityMinutes?: number;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// JS's Date.UTC (which zonedWallTimeToUtcMs is built on) normalizes an
// out-of-range day (e.g. day=31 in a 30-day month) into the following
// month, so passing day+1 here correctly lands on the next calendar day's
// local midnight even across a month/year boundary.
function windowBoundUtcMs(year: number, month: number, day: number, minuteOfDay: number, timezone: string): number {

  if (minuteOfDay >= 1440) {
    const overflowMinute = minuteOfDay - 1440;
    return zonedWallTimeToUtcMs(year, month, day + 1, Math.floor(overflowMinute / 60), overflowMinute % 60, timezone);
  }

  return zonedWallTimeToUtcMs(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, timezone);

}

// Enumerates duration-fit, granularity-aligned, provably-free slots across
// every local calendar day the resolved range touches, in chronological
// order, stopping as soon as candidateCount valid slots have been found.
//
// "Grid-aligned" here means aligned to each day's own effective window
// start (itself clipped against the overall requested range) — for a
// window like "9:00-18:00" that is the same thing as absolute :00/:15/:30/
// :45 boundaries; this file makes no attempt to re-align to those absolute
// boundaries independently of the window start, since no product
// requirement calls for that distinction.
export function generateCandidateSlots(input: SlotEngineInput): CandidateSlot[] {

  const granularityMs = (input.granularityMinutes ?? CANDIDATE_SLOT_GRANULARITY_MINUTES) * 60_000;
  const durationMs = input.durationMinutes * 60_000;
  const rangeStart = Date.parse(input.rangeStartUtc);
  const rangeEnd = Date.parse(input.rangeEndUtc);

  const busy = input.busyIntervals.map((interval) => ({
    start: Date.parse(interval.startUtc),
    end: Date.parse(interval.endUtc),
  }));

  const candidates: CandidateSlot[] = [];

  let cursor = getZonedParts(rangeStart, input.timezone);
  // A generous but finite bound (a bit over a year of days) so a
  // misconfigured range can never spin forever; real usage never
  // approaches this.
  const MAX_DAYS_SCANNED = 400;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED && candidates.length < input.candidateCount; scanned++) {

    const dayWindowStart = windowBoundUtcMs(cursor.year, cursor.month, cursor.day, input.dailyWindow.startMinuteOfDay, input.timezone);

    if (dayWindowStart >= rangeEnd) {
      break;
    }

    const dayWindowEnd = windowBoundUtcMs(cursor.year, cursor.month, cursor.day, input.dailyWindow.endMinuteOfDay, input.timezone);

    const effectiveStart = Math.max(dayWindowStart, rangeStart);
    const effectiveEnd = Math.min(dayWindowEnd, rangeEnd);

    for (
      let slotStart = effectiveStart;
      slotStart + durationMs <= effectiveEnd && candidates.length < input.candidateCount;
      slotStart += granularityMs
    ) {

      const slotEnd = slotStart + durationMs;
      const blocked = busy.some((interval) => overlaps(slotStart, slotEnd, interval.start, interval.end));

      if (!blocked) {
        candidates.push({
          index: candidates.length + 1,
          startUtc: new Date(slotStart).toISOString(),
          endUtc: new Date(slotEnd).toISOString(),
          timezone: input.timezone,
        });
      }

    }

    // Advance the cursor to the next local calendar day. +90 minutes past
    // the day's own window start keeps this safely inside "the next day"
    // even across a DST transition that shifts local midnight's UTC
    // instant by up to an hour.
    const nextDayProbe = dayWindowStart + 24 * 60 * 60_000 + 90 * 60_000;
    cursor = getZonedParts(nextDayProbe, input.timezone);

  }

  return candidates;

}
