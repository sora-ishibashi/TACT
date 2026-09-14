// TACT Work — TIME-P1c: resolves a TIME-P1b TemporalDateConstraint into a
// concrete UTC instant range, given an explicit reference instant and an
// explicit timezone (Section 8 of the TIME-P1c instructions).
//
// Absolute condition (unchanged from TIME-P1b, and the reason this is a
// separate file rather than a change to temporalRequirements.ts): relative
// expressions ("来週" etc.) are never resolved through server/process time.
// Every function here takes referenceInstantUtc and timezone as required
// arguments — nothing in this file ever constructs an implicit "now"
// instant on its own.
//
// Provenance (Section 8): the resolved range never replaces or mutates the
// original TemporalDateConstraint (TIME-P1b's semantic input stays exactly
// as extracted). ResolvedTemporalRange is a separate, derived value that
// carries the original constraint alongside the concrete range it produced,
// so a later audit can see why a given range was chosen.

import type { TemporalDateConstraint } from "./temporalRequirements";
import { isValidCalendarDate } from "./temporalRequirements";
import { getZonedParts, isExplicitUtcInstant, isKnownTimeZone, zonedWallTimeToUtcMs, InvalidLocalWallTimeError } from "./timezone";

export interface ResolvedTemporalRange {
  readonly startUtc: string;
  readonly endUtc: string;
  readonly timezone: string;
  readonly resolvedFrom: TemporalDateConstraint;
}

export type TemporalRangeResolutionErrorCode =
  | "timezone_missing"
  | "timezone_unrecognized"
  // TIME-P1c HARDENING (Blocker C): the reference instant lacked an
  // explicit "Z"/offset marker — resolving it would otherwise depend on
  // Date.parse()'s host-timezone interpretation of a naive datetime.
  | "reference_instant_invalid"
  | "temporal_requirement_incomplete"
  // TIME-P1c HARDENING (Blocker D): a required local wall-clock boundary
  // (e.g. local midnight of the resolved date) does not exist or is
  // ambiguous due to a DST transition on that specific day.
  | "dst_invalid_local_time";

export type TemporalRangeResolution =
  | { readonly success: true; readonly range: ResolvedTemporalRange }
  | { readonly success: false; readonly code: TemporalRangeResolutionErrorCode };

const FRIDAY_WEEKDAY = 5;
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfLocalDayUtc(year: number, month: number, day: number, timezone: string): number {
  return zonedWallTimeToUtcMs(year, month, day, 0, 0, timezone);
}

// Adds `days` calendar days to a (year, month, day) local date by going
// through a UTC-noon anchor for that date — noon avoids any ambiguity from
// DST transitions landing exactly on the added day's local midnight, and
// then re-reads the resulting UTC instant's local date via the same
// timezone. Deterministic; never touches server/process time.
function addLocalDays(year: number, month: number, day: number, days: number, timezone: string): { year: number; month: number; day: number } {
  const anchorUtc = zonedWallTimeToUtcMs(year, month, day, 12, 0, timezone) + days * MS_PER_DAY;
  const parts = getZonedParts(anchorUtc, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function singleDayRange(year: number, month: number, day: number, timezone: string): { startUtc: number; endUtc: number } {
  const start = startOfLocalDayUtc(year, month, day, timezone);
  const next = addLocalDays(year, month, day, 1, timezone);
  const end = startOfLocalDayUtc(next.year, next.month, next.day, timezone);
  return { startUtc: start, endUtc: end };
}

// Parses TIME-P1b's date-string convention, emitted by
// temporalRequirements.ts's toDate(). TIME-P1c FIX (explicit-year date bug):
// toDate() previously concatenated a 4-digit year directly in front of
// "MM-DD" with no separator when a year was present in the input (e.g.
// "202609-14"), which no parser could safely interpret — the year was fixed
// at its source (temporalRequirements.ts) to instead emit a well-formed
// "YYYY-MM-DD". Both of toDate()'s possible shapes are handled explicitly
// here; anything else (including the old malformed concatenation, which may
// still exist in previously-persisted Work.metadata) fails closed rather
// than being guessed at.
const EXPLICIT_YEAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NO_YEAR_DATE = /^(\d{2})-(\d{2})$/;

function resolveExplicitDateToLocalParts(
  dateString: string,
  referenceParts: { year: number; month: number; day: number },
  timezone: string
): { year: number; month: number; day: number } | undefined {

  const explicitYear = dateString.match(EXPLICIT_YEAR_DATE);

  if (explicitYear) {

    const year = Number(explicitYear[1]);
    const month = Number(explicitYear[2]);
    const day = Number(explicitYear[3]);

    // TIME-P1c HARDENING FIX (Codex delta-fix): the year is already known
    // here, so this checks the EXACT day-in-month bound for that specific
    // year (e.g. correctly rejects 2026-02-29 — 2026 is not a leap year —
    // while still accepting 2028-02-29). Reuses
    // temporalRequirements.ts's isValidCalendarDate() rather than a second,
    // possibly-divergent leap-year implementation.
    if (!isValidCalendarDate(month, day, year)) {
      return undefined;
    }

    // An explicit year is exact user intent, never a "nearest upcoming"
    // guess — unlike the no-year case below, this never rolls forward to a
    // different year.
    return { year, month, day };

  }

  const match = dateString.match(NO_YEAR_DATE);

  if (!match) {
    return undefined;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);

  if (!isValidCalendarDate(month, day)) {
    return undefined;
  }

  // No year was supplied — pick the reference year, rolling forward one
  // year if that date has already fully passed relative to the reference
  // instant. This mirrors how a person reads "9/22" without a year: the
  // next upcoming 9/22, never a past one.
  const candidateThisYear = { year: referenceParts.year, month, day };
  const candidateRange = singleDayRange(candidateThisYear.year, candidateThisYear.month, candidateThisYear.day, timezone);
  const referenceInstant = startOfLocalDayUtc(referenceParts.year, referenceParts.month, referenceParts.day, timezone);

  if (candidateRange.endUtc > referenceInstant) {
    return candidateThisYear;
  }

  return { year: referenceParts.year + 1, month, day };

}

export function resolveTemporalDateRange(
  date: TemporalDateConstraint | undefined,
  referenceInstantUtc: string,
  timezone: string | undefined
): TemporalRangeResolution {

  if (!timezone) {
    return { success: false, code: "timezone_missing" };
  }

  if (!isKnownTimeZone(timezone)) {
    return { success: false, code: "timezone_unrecognized" };
  }

  if (!date) {
    return { success: false, code: "temporal_requirement_incomplete" };
  }

  // TIME-P1c HARDENING (Blocker C, absolute condition): reject a naive
  // reference instant (no "Z", no explicit ±HH:MM offset) before it can
  // ever reach Date.parse(), which would otherwise interpret it using the
  // host/process timezone — exactly the implicit-timezone dependency this
  // phase exists to eliminate.
  if (!isExplicitUtcInstant(referenceInstantUtc)) {
    return { success: false, code: "reference_instant_invalid" };
  }

  const referenceEpochMs = Date.parse(referenceInstantUtc);

  if (!Number.isFinite(referenceEpochMs)) {
    return { success: false, code: "temporal_requirement_incomplete" };
  }

  try {
    return resolveExplicitlyValidatedDateRange(date, referenceEpochMs, timezone);
  } catch (error) {
    if (error instanceof InvalidLocalWallTimeError) {
      return { success: false, code: "dst_invalid_local_time" };
    }
    throw error;
  }

}

// TIME-P1c HARDENING (Blocker D): isolated so the single try/catch above
// covers every zonedWallTimeToUtcMs() call this resolution path can reach
// (directly, or transitively via startOfLocalDayUtc/addLocalDays/
// singleDayRange/resolveExplicitDateToLocalParts) without scattering a
// try/catch at each call site.
function resolveExplicitlyValidatedDateRange(
  date: TemporalDateConstraint,
  referenceEpochMs: number,
  timezone: string
): TemporalRangeResolution {

  const referenceParts = getZonedParts(referenceEpochMs, timezone);

  if (date.kind === "relative") {

    switch (date.value) {

      case "today": {
        const { startUtc, endUtc } = singleDayRange(referenceParts.year, referenceParts.month, referenceParts.day, timezone);
        return finish(startUtc, endUtc, timezone, date);
      }

      case "tomorrow": {
        const tomorrow = addLocalDays(referenceParts.year, referenceParts.month, referenceParts.day, 1, timezone);
        const { startUtc, endUtc } = singleDayRange(tomorrow.year, tomorrow.month, tomorrow.day, timezone);
        return finish(startUtc, endUtc, timezone, date);
      }

      case "this_week": {
        // From today (inclusive — a past day within the same week is not a
        // useful scheduling target) through the end of the current ISO
        // week (Sunday 24:00 local).
        const daysUntilSunday = (DAYS_PER_WEEK - referenceParts.weekday) % DAYS_PER_WEEK;
        const sunday = addLocalDays(referenceParts.year, referenceParts.month, referenceParts.day, daysUntilSunday, timezone);
        const mondayAfter = addLocalDays(sunday.year, sunday.month, sunday.day, 1, timezone);
        const startUtc = startOfLocalDayUtc(referenceParts.year, referenceParts.month, referenceParts.day, timezone);
        const endUtc = startOfLocalDayUtc(mondayAfter.year, mondayAfter.month, mondayAfter.day, timezone);
        return finish(startUtc, endUtc, timezone, date);
      }

      case "next_week": {
        // The upcoming Monday through the following Monday (exclusive),
        // i.e. a full Mon-Sun week that has not started yet.
        const daysUntilNextMonday = ((8 - referenceParts.weekday) % DAYS_PER_WEEK) || DAYS_PER_WEEK;
        const nextMonday = addLocalDays(referenceParts.year, referenceParts.month, referenceParts.day, daysUntilNextMonday, timezone);
        const followingMonday = addLocalDays(nextMonday.year, nextMonday.month, nextMonday.day, DAYS_PER_WEEK, timezone);
        const startUtc = startOfLocalDayUtc(nextMonday.year, nextMonday.month, nextMonday.day, timezone);
        const endUtc = startOfLocalDayUtc(followingMonday.year, followingMonday.month, followingMonday.day, timezone);
        return finish(startUtc, endUtc, timezone, date);
      }

      case "friday": {
        // The upcoming Friday, including today if today already is Friday.
        const daysUntilFriday = (FRIDAY_WEEKDAY - referenceParts.weekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
        const friday = addLocalDays(referenceParts.year, referenceParts.month, referenceParts.day, daysUntilFriday, timezone);
        const { startUtc, endUtc } = singleDayRange(friday.year, friday.month, friday.day, timezone);
        return finish(startUtc, endUtc, timezone, date);
      }

    }

  }

  if (date.kind === "date") {

    const resolved = resolveExplicitDateToLocalParts(date.date, referenceParts, timezone);

    if (!resolved) {
      return { success: false, code: "temporal_requirement_incomplete" };
    }

    const { startUtc, endUtc } = singleDayRange(resolved.year, resolved.month, resolved.day, timezone);
    return finish(startUtc, endUtc, timezone, date);

  }

  // date.kind === "range"
  const start = resolveExplicitDateToLocalParts(date.start, referenceParts, timezone);
  const end = resolveExplicitDateToLocalParts(date.end, referenceParts, timezone);

  if (!start || !end) {
    return { success: false, code: "temporal_requirement_incomplete" };
  }

  const startUtc = startOfLocalDayUtc(start.year, start.month, start.day, timezone);
  const endExclusiveDay = addLocalDays(end.year, end.month, end.day, 1, timezone);
  const endUtc = startOfLocalDayUtc(endExclusiveDay.year, endExclusiveDay.month, endExclusiveDay.day, timezone);

  if (endUtc <= startUtc) {
    return { success: false, code: "temporal_requirement_incomplete" };
  }

  return finish(startUtc, endUtc, timezone, date);

}

function finish(
  startUtcMs: number,
  endUtcMs: number,
  timezone: string,
  resolvedFrom: TemporalDateConstraint
): TemporalRangeResolution {

  return {
    success: true,
    range: {
      startUtc: new Date(startUtcMs).toISOString(),
      endUtc: new Date(endUtcMs).toISOString(),
      timezone,
      resolvedFrom,
    },
  };

}
