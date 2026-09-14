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

// The UTC offset (in minutes, local-minus-UTC — so e.g. JST is +540) that
// `timeZone` has in effect AT a given UTC instant. Built from the same
// primitive (getZonedParts + Date.UTC) already used elsewhere in this file.
function getUtcOffsetMinutesAt(epochMs: number, timeZone: string): number {
  const parts = getZonedParts(epochMs, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asIfUtc - epochMs) / 60_000;
}

// TIME-P1c HARDENING FIX (final-blocker round, Blocker 3 — Codex-reproduced
// non-1-hour DST fold, e.g. Australia/Lord_Howe's 30-minute transition;
// extracted further for the DST-fold-final round, Section 9): this is the
// SINGLE semantic authority for "how many real UTC instants does this local
// wall-clock date/time correspond to in this timezone" — every caller that
// needs an answer to that question (zonedWallTimeToUtcMs()'s throwing
// contract below, and core/tact-work/slotEngine.ts's non-throwing
// per-candidate uniqueness check) is a thin wrapper around this one
// function, so there is exactly one DST-fold algorithm in the codebase, not
// two independently-maintained heuristics.
//
// Offset-discovery approach (general, not hour-hardcoded):
//   1. Sample the zone's actual UTC offset at two probe instants 24 hours
//      before and 24 hours after the naive (wall-clock-as-UTC) target — a
//      margin comfortably wider than any single real-world DST transition's
//      window, so it reliably lands on ordinary (non-transitioning) ground
//      on each side of whatever transition might be nearby. If a timezone
//      ever changed its DST rule twice within 48 hours (essentially
//      unheard of in real IANA data), this could miss it — a documented,
//      accepted v1 limitation, not a silent correctness claim.
//   2. If both probes report the SAME offset, there is no DST transition
//      anywhere near this wall-clock time at all — exactly one candidate
//      offset to try.
//   3. If they differ, there are exactly two candidate offsets (the one
//      before the transition and the one after) — try both, regardless of
//      whether they differ by 30, 60, or any other number of minutes; this
//      is what makes the algorithm general rather than hour-shaped.
//   4. For each candidate offset, compute the resulting instant and
//      round-trip it back through getZonedParts() in the SAME timezone,
//      keeping only the ones that reproduce the exact requested wall-clock
//      reading.
// Returns every distinct matching instant: zero means the wall time never
// occurred (spring-forward gap), exactly one means it is unambiguous, two
// or more means it is a genuine fall-back fold.
function findMatchingInstantsForLocalWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number[] {

  const targetAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  const OFFSET_DISCOVERY_MARGIN_MS = 24 * 60 * 60_000;
  const earlyOffsetMinutes = getUtcOffsetMinutesAt(targetAsIfUtc - OFFSET_DISCOVERY_MARGIN_MS, timeZone);
  const lateOffsetMinutes = getUtcOffsetMinutesAt(targetAsIfUtc + OFFSET_DISCOVERY_MARGIN_MS, timeZone);

  const candidateOffsetsMinutes = earlyOffsetMinutes === lateOffsetMinutes
    ? [earlyOffsetMinutes]
    : [earlyOffsetMinutes, lateOffsetMinutes];

  const matchingInstants: number[] = [];

  for (const offsetMinutes of candidateOffsetsMinutes) {

    const candidateInstant = targetAsIfUtc - offsetMinutes * 60_000;
    const candidateParts = getZonedParts(candidateInstant, timeZone);

    if (wallTimeMatches(candidateParts, year, month, day, hour, minute) && !matchingInstants.includes(candidateInstant)) {
      matchingInstants.push(candidateInstant);
    }

  }

  return matchingInstants;

}

export type LocalWallTimeUniqueness = "nonexistent" | "unique" | "ambiguous";

// TIME-P1c HARDENING FIX (DST-fold-final round, Section 9): non-throwing
// classification built on the same authority as zonedWallTimeToUtcMs()
// below — used where ambiguity is an expected, silently-skippable condition
// (candidate-slot filtering) rather than an exceptional one (resolving a
// single required wall-clock boundary), so that path never needs to
// construct/catch an InvalidLocalWallTimeError just to ask this question.
export function classifyLocalWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): LocalWallTimeUniqueness {

  const matches = findMatchingInstantsForLocalWallTime(year, month, day, hour, minute, timeZone);

  if (matches.length === 0) {
    return "nonexistent";
  }

  if (matches.length >= 2) {
    return "ambiguous";
  }

  return "unique";

}

// Converts an explicit wall-clock date/time in an explicit IANA timezone
// into a UTC epoch instant.
//
// V1 policy (documented, matches Section 6): both failure cases always
// throw — no caller in this codebase currently supplies an explicit UTC
// offset capable of disambiguating an ambiguous reading, so this function
// never silently normalizes a nonexistent time to a different clock time,
// and never arbitrarily picks one of several repeated occurrences.
export function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {

  const matchingInstants = findMatchingInstantsForLocalWallTime(year, month, day, hour, minute, timeZone);

  if (matchingInstants.length === 0) {

    throw new InvalidLocalWallTimeError(
      "nonexistent",
      `Local time ${year}-${month}-${day} ${hour}:${minute} in ${timeZone} does not exist (falls inside a DST spring-forward gap).`
    );

  }

  if (matchingInstants.length >= 2) {

    throw new InvalidLocalWallTimeError(
      "ambiguous",
      `Local time ${year}-${month}-${day} ${hour}:${minute} in ${timeZone} is ambiguous (occurs more than once due to a DST fall-back) and no explicit UTC offset was given to disambiguate it.`
    );

  }

  return matchingInstants[0];

}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// TIME-P1c HARDENING FIX (final-blocker round, Blocker 2 — month/year
// boundary crash): deterministic "local calendar date ± N days" arithmetic
// that never passes an out-of-range day (0, 32, -1, ...) into
// zonedWallTimeToUtcMs(). Before this function existed, callers computed
// "previous/next local day" by passing `day - 1` / `day + 1` directly to
// zonedWallTimeToUtcMs() and relying on `Date.UTC`'s own day-overflow
// rollover to land on the right real calendar date — which worked fine
// against the ORIGINAL (pre-DST-hardening) implementation, but the
// DST-safety round-trip check added since then compares the result's real
// calendar day (always 1-31) against the literal (possibly 0 or 32) day
// that was passed in, which can never match, and so incorrectly raised
// InvalidLocalWallTimeError purely because a month or year boundary was
// crossed (e.g. seeding "the day before 2026-11-01" as day=0).
//
// This never passes an overflowing day into zonedWallTimeToUtcMs(). It
// anchors at LOCAL NOON of the given, already-valid (year, month, day) —
// noon is never subject to a DST spring-forward gap or fall-back ambiguity
// in any real IANA zone, so this starting call always succeeds — adds
// `deltaDays` whole days as raw milliseconds (safe arithmetic, no calendar
// validity concerns), and re-derives the real resulting calendar date via
// getZonedParts(). A DST shift can move the landing instant a few hours off
// noon, but never far enough to cross a midnight boundary, so the derived
// (year, month, day) is always exactly the intended calendar date.
export function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
  timeZone: string
): { year: number; month: number; day: number } {

  const anchorMs = zonedWallTimeToUtcMs(year, month, day, 12, 0, timeZone) + deltaDays * MS_PER_DAY;
  const parts = getZonedParts(anchorMs, timeZone);

  return { year: parts.year, month: parts.month, day: parts.day };

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
