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
import { addCalendarDays, classifyLocalWallTime, getZonedParts, zonedWallTimeToUtcMs, InvalidLocalWallTimeError } from "./timezone";

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

// TIME-P1c HARDENING FIX (Blocker A, grid alignment): candidate starts must
// land on absolute local-clock boundaries (:00/:15/:30/:45 for the default
// 15-minute grid) in the scheduling timezone — not merely at whatever
// instant a window/range happens to start at. Rounds UP to the nearest such
// boundary strictly at-or-after `instantMs` (a value already exactly on a
// boundary, with no sub-minute remainder, is returned unchanged).
//
// Ceiling to the next whole minute first (via instantMs, not the
// timezone-derived `second` field, since seconds-within-a-minute are
// timezone-invariant) defensively covers a busy interval or range boundary
// that happens to carry sub-minute precision — the grid itself is always
// minute-granular.
function alignUpToLocalGrid(instantMs: number, timezone: string, granularityMinutes: number): number {

  const wholeMinuteMs = Math.ceil(instantMs / 60_000) * 60_000;
  const parts = getZonedParts(wholeMinuteMs, timezone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const remainder = minuteOfDay % granularityMinutes;
  const minutesToAdd = remainder === 0 ? 0 : granularityMinutes - remainder;

  return wholeMinuteMs + minutesToAdd * 60_000;

}

// TIME-P1c HARDENING FIX (final-blocker round, Blocker 2 — month/year
// boundary crash): the overflow branch previously passed `day + 1` directly
// into zonedWallTimeToUtcMs(), relying on Date.UTC's own rollover to land
// on the right real calendar date — this broke once zonedWallTimeToUtcMs()
// started round-trip-validating its result (Blocker D), since a real
// calendar day (1-31) can never equal the literal overflowing `day + 1`
// (e.g. day=32) that was passed in. addCalendarDays() (timezone.ts) is now
// used to normalize the day FIRST, so only ever-valid (year, month, day)
// triples reach zonedWallTimeToUtcMs().
//
// TIME-P1c HARDENING (Blocker D): returns undefined, rather than throwing
// or silently normalizing, when this specific day's window boundary falls
// on a DST gap/ambiguity. The caller treats an undefined boundary as "this
// day's window cannot be safely resolved" and skips generating any
// candidates for that one day — it does not abort scanning the rest of the
// requested range, since a DST quirk on one day should not hide otherwise
// valid candidates on other days.
function windowBoundUtcMs(year: number, month: number, day: number, minuteOfDay: number, timezone: string): number | undefined {

  try {

    if (minuteOfDay >= 1440) {
      const overflowMinute = minuteOfDay - 1440;
      const nextDay = addCalendarDays(year, month, day, 1, timezone);
      return zonedWallTimeToUtcMs(nextDay.year, nextDay.month, nextDay.day, Math.floor(overflowMinute / 60), overflowMinute % 60, timezone);
    }

    return zonedWallTimeToUtcMs(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, timezone);

  } catch (error) {

    if (error instanceof InvalidLocalWallTimeError) {
      return undefined;
    }

    throw error;

  }

}

// Enumerates duration-fit, granularity-aligned, provably-free slots across
// every local calendar day the resolved range touches, in chronological
// order, stopping as soon as candidateCount valid slots have been found.
//
// "Grid-aligned" (TIME-P1c HARDENING, Blocker A) means aligned to absolute
// local-clock boundaries (:00/:15/:30/:45 in the scheduling timezone) via
// alignUpToLocalGrid() above — independent of exactly where a window or the
// requested range happens to start. Duration itself is never required to be
// a multiple of the grid.
export function generateCandidateSlots(input: SlotEngineInput): CandidateSlot[] {

  const granularityMinutes = input.granularityMinutes ?? CANDIDATE_SLOT_GRANULARITY_MINUTES;
  const granularityMs = granularityMinutes * 60_000;
  const durationMs = input.durationMinutes * 60_000;
  const rangeStart = Date.parse(input.rangeStartUtc);
  const rangeEnd = Date.parse(input.rangeEndUtc);

  const busy = input.busyIntervals.map((interval) => ({
    start: Date.parse(interval.startUtc),
    end: Date.parse(interval.endUtc),
  }));

  const candidates: CandidateSlot[] = [];

  // TIME-P1c HARDENING FIX (Blocker B, overnight carry-over): seed the scan
  // one local calendar day BEFORE the range start's own local day. Without
  // this, an overnight dailyWindow (e.g. 22:00-02:00) that began the
  // previous local day and carries into the requested range (e.g. a range
  // starting at 00:30) was never considered at all — the old code only ever
  // started scanning from rangeStart's own local day forward. Seeding one
  // day early is always safe: a day whose window does not actually overlap
  // [rangeStart, rangeEnd) simply clips to an empty effective window below
  // (effectiveStart >= effectiveEnd) and contributes zero candidates, same
  // as any other out-of-range day.
  // TIME-P1c HARDENING FIX (final-blocker round, Blocker 2): uses
  // addCalendarDays() rather than passing `day - 1` directly into a
  // timezone conversion — see addCalendarDays()'s own comment (timezone.ts)
  // for why that overflowing-day pattern broke at month/year boundaries
  // once zonedWallTimeToUtcMs() started round-trip-validating its result.
  const rangeStartLocalParts = getZonedParts(rangeStart, input.timezone);
  let cursor = addCalendarDays(rangeStartLocalParts.year, rangeStartLocalParts.month, rangeStartLocalParts.day, -1, input.timezone);

  // A generous but finite bound (a bit over a year of days) so a
  // misconfigured range can never spin forever; real usage never
  // approaches this.
  const MAX_DAYS_SCANNED = 400;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED && candidates.length < input.candidateCount; scanned++) {

    const dayWindowStart = windowBoundUtcMs(cursor.year, cursor.month, cursor.day, input.dailyWindow.startMinuteOfDay, input.timezone);
    const dayWindowEnd = dayWindowStart === undefined
      ? undefined
      : windowBoundUtcMs(cursor.year, cursor.month, cursor.day, input.dailyWindow.endMinuteOfDay, input.timezone);

    // TIME-P1c HARDENING (Blocker D): this specific day's window boundary
    // fell on a DST gap/ambiguity (windowBoundUtcMs() returned undefined).
    // Never guess/normalize it — skip only this one day's candidate
    // generation and keep scanning the rest of the range; the loop can
    // still terminate via the day-count bound below even if a boundary is
    // unresolvable, since we cannot evaluate the usual "past rangeEnd"
    // break condition without a resolved instant.
    if (dayWindowStart !== undefined && dayWindowEnd !== undefined) {

      if (dayWindowStart >= rangeEnd) {
        break;
      }

      const effectiveStart = Math.max(dayWindowStart, rangeStart);
      const effectiveEnd = Math.min(dayWindowEnd, rangeEnd);

      if (effectiveStart < effectiveEnd) {

        for (
          let slotStart = alignUpToLocalGrid(effectiveStart, input.timezone, granularityMinutes);
          slotStart + durationMs <= effectiveEnd && candidates.length < input.candidateCount;
          slotStart += granularityMs
        ) {

          // TIME-P1c HARDENING FIX (DST-fold-final round, Blocker: duplicate
          // local wall-clock candidates): stepping through UTC instants at a
          // fixed millisecond granularity is not sufficient on its own — a
          // DST fall-back fold means two DIFFERENT UTC instants within this
          // day's window can map back to the exact SAME local wall-clock
          // reading (e.g. both 05:00 UTC and 06:00 UTC read as "01:00" local
          // in America/New_York on the fold day). "Unique UTC instant" is
          // not the same guarantee as "unique local scheduling time" — a
          // user must never see the same local label offered twice, or be
          // silently handed one arbitrary occurrence of an ambiguous one.
          //
          // v1 policy (Section 1/3/4): an ambiguous local wall-clock
          // candidate is skipped entirely — never displayed, on either
          // occurrence, and never disambiguated by an implicit "earlier" or
          // "later" choice. This reuses classifyLocalWallTime() — the exact
          // same DST-fold authority zonedWallTimeToUtcMs() itself is built
          // on (core/tact-work/timezone.ts) — rather than a second,
          // independently-maintained heuristic.
          const slotStartLocalParts = getZonedParts(slotStart, input.timezone);
          const uniqueness = classifyLocalWallTime(
            slotStartLocalParts.year,
            slotStartLocalParts.month,
            slotStartLocalParts.day,
            slotStartLocalParts.hour,
            slotStartLocalParts.minute,
            input.timezone
          );

          if (uniqueness === "unique") {

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
          // "nonexistent" is not reachable here in practice — slotStart is
          // always a real instant, and every real instant has SOME valid
          // local reading — but is deliberately handled the same way
          // (skip, never emit) for defense in depth, not just "ambiguous".

        }

      }

    }

    // Advance the cursor to the next local calendar day. TIME-P1c HARDENING
    // FIX (Blocker B follow-up): anchor at local NOON of cursor.day + 1
    // rather than "+24h+90min past dayWindowStart" — the old probe assumed
    // a window start time far enough from midnight that adding 90 minutes
    // would still land within the intended next day, which silently
    // overshot by a full calendar day whenever dailyWindow.startMinuteOfDay
    // was close to midnight (e.g. 23:45), skipping that day's window
    // entirely. Noon is never subject to a spring-forward/fall-back DST gap
    // or ambiguity, so this is always exactly "cursor's day + 1" regardless
    // of window timing or DST.
    //
    // TIME-P1c HARDENING FIX (final-blocker round, Blocker 2): uses
    // addCalendarDays() rather than passing `cursor.day + 1` directly into
    // a timezone conversion, which broke at month/year boundaries (e.g.
    // day=31 -> 32) once zonedWallTimeToUtcMs() started round-trip-
    // validating its result.
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1, input.timezone);

  }

  return candidates;

}
