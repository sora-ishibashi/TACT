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

// Converts an explicit wall-clock date/time in an explicit IANA timezone
// into a UTC epoch instant. Handles DST correctly by iteratively correcting
// an initial guess against how that guess actually renders in the target
// zone (the same technique used by date-fns-tz's zonedTimeToUtc / Temporal
// polyfills) — two correction passes are sufficient because a timezone
// offset only ever changes by whole hours at DST boundaries.
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
