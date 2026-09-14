// TACT Work — TIME-P1c: minimal IANA timezone conversion helpers.
//
// Why this file exists: TIME-P1b deliberately never resolves a relative
// date/clock time into a concrete instant, because no reliable timezone
// source existed anywhere in the repository (confirmed by Repository
// Reality Audit before this phase — see temporalRequirements.ts comment).
// TIME-P1c is the first place that legitimately does this conversion, and
// only once a timezone is explicit (never inferred from server/process
// state — see Section 7 of the TIME-P1c instructions).
//
// This uses only the platform's built-in Intl/ICU support (Node has full
// ICU by default). No new date/timezone dependency is added — none existed
// in package.json before this phase, and the conversions needed here
// (wall-clock <-> UTC instant for an explicit IANA zone) do not require
// one.
//
// Absolute condition carried over from temporalRequirements.ts: nothing in
// this file may read the server/process local timezone implicitly. Every
// function here takes an explicit `timeZone` argument; there is no
// zero-argument "now in local time" helper.

export interface ZonedDateParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number;
  readonly second: number;
  // 0=Sunday .. 6=Saturday, matching Date.prototype.getUTCDay() convention.
  readonly weekday: number;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Reads the wall-clock date/time that a given UTC instant represents inside
// an explicit IANA timezone. Throws only if `timeZone` is not a timezone
// name the runtime recognizes (callers are expected to validate the zone
// name against isKnownTimeZone() before persisting it, so this should not
// normally throw in practice).
export function getZonedParts(epochMs: number, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(new Date(epochMs));
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  const rawHour = byType.get("hour") ?? "00";

  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    // hourCycle:"h23" can still format local midnight as "24" in some ICU
    // versions; normalize that one edge case defensively.
    hour: rawHour === "24" ? 0 : Number(rawHour),
    minute: Number(byType.get("minute") ?? "0"),
    second: Number(byType.get("second") ?? "0"),
    weekday: WEEKDAY_NAMES.indexOf(byType.get("weekday") ?? ""),
  };
}

// TIME-P1c HARDENING (Blocker D): thrown by zonedWallTimeToUtcMs() when the
// requested local wall-clock date/time cannot be safely converted to a
// single, unambiguous instant. "nonexistent" = the wall time falls inside a
// DST spring-forward gap (it never occurs at all, e.g. 2:30 AM on the day
// clocks jump from 2:00 to 3:00). "ambiguous" = the wall time occurs twice,
// once before and once after a DST fall-back (e.g. 1:30 AM occurring in
// both the pre- and post-transition hour), and nothing in this codebase's
// current inputs carries an explicit UTC offset that could disambiguate
// which occurrence was meant.
export class InvalidLocalWallTimeError extends Error {

  constructor(public readonly reason: "nonexistent" | "ambiguous", message: string) {
    super(message);
    this.name = "InvalidLocalWallTimeError";
  }

}

function wallTimeMatches(
  parts: ZonedDateParts,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): boolean {
  return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
}

// Converts an explicit wall-clock date/time in an explicit IANA timezone
// into a UTC epoch instant. Handles DST correctly by iteratively correcting
// an initial guess against how that guess actually renders in the target
// zone (the same technique used by date-fns-tz's zonedTimeToUtc / Temporal
// polyfills) — two correction passes are sufficient because a timezone
// offset only ever changes by whole hours at DST boundaries.
//
// TIME-P1c HARDENING (Blocker D, absolute condition): after computing a
// candidate instant, this round-trips it back through getZonedParts() in
// the SAME timezone and confirms it reproduces exactly the requested
// wall-clock components — the naive correction above can otherwise land on
// a plausible-looking but wrong instant when the requested local time falls
// inside a DST spring-forward gap (nonexistent) or fall-back repeat
// (ambiguous). V1 policy (documented, matches Section 6): a nonexistent
// local time always throws; an ambiguous one always throws too, since no
// caller in this codebase currently supplies an explicit UTC offset capable
// of disambiguating which occurrence was meant — this function never
// silently normalizes 02:30 to 03:30, and never arbitrarily picks one of
// two repeated occurrences. Known limitation: assumes DST transitions shift
// the offset by a whole number of hours, which covers the overwhelming
// majority of real IANA zones (a small number of historical/exotic
// half-hour DST shifts, e.g. Lord Howe Island, are out of scope for v1).
export function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {

  const targetAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetAsIfUtc;

  for (let attempt = 0; attempt < 2; attempt++) {

    const zoned = getZonedParts(guess, timeZone);
    const zonedAsIfUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    const driftMs = zonedAsIfUtc - targetAsIfUtc;

    if (driftMs === 0) {
      break;
    }

    guess -= driftMs;

  }

  const finalParts = getZonedParts(guess, timeZone);

  if (!wallTimeMatches(finalParts, year, month, day, hour, minute)) {

    // The corrected guess does not reproduce the requested wall time at
    // all — that wall time never occurred (spring-forward gap). A repeated
    // (ambiguous) wall time, by contrast, DOES round-trip correctly (both
    // valid instants reproduce the same reading) — that case is detected
    // below, independently of this branch.
    throw new InvalidLocalWallTimeError(
      "nonexistent",
      `Local time ${year}-${month}-${day} ${hour}:${minute} in ${timeZone} does not exist (falls inside a DST spring-forward gap).`
    );

  }

  // Ambiguity check (fall-back repeat): if the instant exactly one hour
  // earlier OR exactly one hour later ALSO reproduces the identical
  // requested wall-clock reading, this hour occurs twice in this timezone
  // on this day and `guess` is only one of the two equally-valid instants.
  // Both directions must be checked — the iterative correction above can
  // converge to EITHER the earlier (pre-fall-back) or later (post-fall-back)
  // occurrence depending on where the initial naive guess happened to land,
  // and the other occurrence is one hour away in whichever direction that
  // is (per this function's documented whole-hour-DST assumption).
  const oneHourEarlierParts = getZonedParts(guess - 60 * 60_000, timeZone);
  const oneHourLaterParts = getZonedParts(guess + 60 * 60_000, timeZone);

  if (
    wallTimeMatches(oneHourEarlierParts, year, month, day, hour, minute) ||
    wallTimeMatches(oneHourLaterParts, year, month, day, hour, minute)
  ) {

    throw new InvalidLocalWallTimeError(
      "ambiguous",
      `Local time ${year}-${month}-${day} ${hour}:${minute} in ${timeZone} is ambiguous (occurs twice due to a DST fall-back) and no explicit UTC offset was given to disambiguate it.`
    );

  }

  return guess;

}

// Fail-closed validation of a user-supplied timezone. Deliberately does not
// accept city names, abbreviations (e.g. "JST"), or offsets (e.g. "+09:00")
// — only IANA identifiers Intl itself recognizes (e.g. "Asia/Tokyo"). This
// never guesses a "close enough" zone (Section 7 absolute condition).
export function isKnownTimeZone(candidate: string): boolean {

  if (!candidate) {
    return false;
  }

  try {

    if (typeof Intl.supportedValuesOf === "function") {
      return Intl.supportedValuesOf("timeZone").includes(candidate);
    }

  } catch {
    // Falls through to the defensive formatter probe below.
  }

  // Fallback only for a runtime without Intl.supportedValuesOf (this
  // project's Node 24 always has it, so this branch is not reachable in
  // practice). Known limitation: some runtimes' Intl.DateTimeFormat accepts
  // a few non-IANA legacy abbreviations (e.g. "JST") without throwing, so
  // this fallback is best-effort rather than as strict as the primary path.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }

}

// TIME-P1c HARDENING (Blocker C): an instant string is only accepted if it
// unambiguously names a single point in time — an explicit "Z" (UTC) or an
// explicit numeric "+HH:MM"/"-HH:MM" offset. A "naive" datetime with no
// zone/offset at all (e.g. "2026-09-14T12:00:00") is rejected outright
// here, before it ever reaches `Date.parse()` — `Date.parse()` on such a
// string is specified (ECMA-262) to interpret it in the HOST/process
// timezone, which is exactly the implicit-timezone leak this phase exists
// to eliminate (Section 5/7 of the original TIME-P1c instructions). This
// also rejects date-only forms ("2026-09-14", which Date.parse() treats as
// UTC midnight but which carries no explicit indication that the caller
// intended a full instant) — callers needing "reference instant" semantics
// must supply a complete date-time with an explicit zone marker.
const EXPLICIT_OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isExplicitUtcInstant(value: string): boolean {
  return typeof value === "string" && EXPLICIT_OFFSET_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
