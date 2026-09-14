import { isExplicitUtcInstant, zonedWallTimeToUtcMs, addCalendarDays, InvalidLocalWallTimeError } from "../../../core/tact-work/timezone";
import { resolveTemporalDateRange } from "../../../core/tact-work/temporalRange";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c HARDENING — Blocker C (naive reference instant) and Blocker D
// (DST gap/ambiguity) regression coverage.
//
// The DST fixtures below use real, verified 2026 US transition dates
// (America/New_York): spring-forward on 2026-03-08 (2nd Sunday of March,
// 02:00 -> 03:00, so 02:00-02:59 never occurs), and fall-back on
// 2026-11-01 (1st Sunday of November, 02:00 -> 01:00, so 01:00-01:59
// occurs twice) — confirmed against the installed ICU timezone data before
// writing these assertions, not guessed.

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // Blocker C: naive reference instant safety
  // =========================

  results.push(check("[Blocker C] a naive datetime with no zone marker is rejected", !isExplicitUtcInstant("2026-09-14T12:00:00")));
  results.push(check("[Blocker C] a date-only string is rejected (no explicit time/zone at all)", !isExplicitUtcInstant("2026-09-14")));
  results.push(check("[Blocker C] a trailing \"Z\" is accepted", isExplicitUtcInstant("2026-09-14T12:00:00Z")));
  results.push(check("[Blocker C] an explicit +HH:MM offset is accepted", isExplicitUtcInstant("2026-09-14T12:00:00+09:00")));
  results.push(check("[Blocker C] an explicit -HH:MM offset is accepted", isExplicitUtcInstant("2026-09-14T12:00:00-05:00")));
  results.push(check("[Blocker C] garbage input is rejected, never crashes", !isExplicitUtcInstant("not-a-date") && !isExplicitUtcInstant("")));

  const naiveReference = resolveTemporalDateRange(
    { kind: "relative", value: "tomorrow" },
    "2026-09-14T12:00:00", // naive — no Z, no offset
    "Asia/Tokyo"
  );
  results.push(check(
    "[Blocker C] resolveTemporalDateRange() rejects a naive reference instant rather than letting Date.parse() use host time",
    !naiveReference.success && naiveReference.code === "reference_instant_invalid"
  ));

  const zReference = resolveTemporalDateRange({ kind: "relative", value: "today" }, "2026-09-14T00:00:00Z", "Asia/Tokyo");
  results.push(check("[Blocker C] a \"Z\" reference instant is accepted", zReference.success));

  const offsetReference = resolveTemporalDateRange({ kind: "relative", value: "today" }, "2026-09-14T09:00:00+09:00", "Asia/Tokyo");
  results.push(check("[Blocker C] an explicit-offset reference instant is accepted", offsetReference.success));

  if (zReference.success && offsetReference.success) {
    results.push(check(
      "[Blocker C] a \"Z\" instant and its equivalent explicit-offset form resolve to the same range (same point in time, different spelling)",
      zReference.range.startUtc === offsetReference.range.startUtc && zReference.range.endUtc === offsetReference.range.endUtc
    ));
  }

  // =========================
  // Blocker D: DST gap/ambiguity safety (core primitive)
  // =========================

  let gapThrew: InvalidLocalWallTimeError | undefined;
  try {
    zonedWallTimeToUtcMs(2026, 3, 8, 2, 30, "America/New_York"); // inside the spring-forward gap
  } catch (error) {
    if (error instanceof InvalidLocalWallTimeError) gapThrew = error;
  }
  results.push(check(
    "[Blocker D] a nonexistent local time (DST spring-forward gap) fails closed, never silently normalized to a different clock time",
    gapThrew?.reason === "nonexistent"
  ));

  let ambiguousThrew: InvalidLocalWallTimeError | undefined;
  try {
    zonedWallTimeToUtcMs(2026, 11, 1, 1, 30, "America/New_York"); // occurs twice (fall-back)
  } catch (error) {
    if (error instanceof InvalidLocalWallTimeError) ambiguousThrew = error;
  }
  results.push(check(
    "[Blocker D] an ambiguous repeated local time (DST fall-back) fails closed rather than arbitrarily picking one occurrence",
    ambiguousThrew?.reason === "ambiguous"
  ));

  results.push(check(
    "[Blocker D] a normal (non-transition-day) local time never throws",
    (() => {
      try {
        zonedWallTimeToUtcMs(2026, 9, 14, 9, 0, "Asia/Tokyo");
        return true;
      } catch {
        return false;
      }
    })()
  ));

  results.push(check(
    "[Blocker D] the instant immediately before a spring-forward gap resolves normally",
    (() => {
      try {
        zonedWallTimeToUtcMs(2026, 3, 8, 1, 59, "America/New_York");
        return true;
      } catch {
        return false;
      }
    })()
  ));

  results.push(check(
    "[Blocker D] the instant immediately after a spring-forward gap resolves normally",
    (() => {
      try {
        zonedWallTimeToUtcMs(2026, 3, 8, 3, 0, "America/New_York");
        return true;
      } catch {
        return false;
      }
    })()
  ));

  results.push(check(
    "[Blocker D] the instant immediately after a fall-back repeat (no longer ambiguous) resolves normally",
    (() => {
      try {
        zonedWallTimeToUtcMs(2026, 11, 1, 2, 0, "America/New_York");
        return true;
      } catch {
        return false;
      }
    })()
  ));

  // =========================
  // Blocker D: end-to-end through resolveTemporalDateRange()
  // =========================
  //
  // US zones' DST transitions happen at 2am local, so an ordinary calendar
  // date's local midnight is never affected there — a genuinely reachable
  // end-to-end fixture instead needs a real zone whose transition occurs AT
  // local midnight. America/Santiago (Chile) is exactly that: confirmed
  // (not guessed) by directly scanning zonedWallTimeToUtcMs() across all of
  // 2026 before writing this assertion — 2026-09-06 00:00 America/Santiago
  // does not exist (spring-forward gap at midnight).
  const dstInvalidDateRange = resolveTemporalDateRange(
    { kind: "date", date: "2026-09-06" },
    "2026-09-01T00:00:00Z",
    "America/Santiago"
  );
  results.push(check(
    "[Blocker D] a requested date whose local midnight is a real DST gap fails closed with a distinguishable dst_invalid_local_time, never a fabricated range",
    !dstInvalidDateRange.success && dstInvalidDateRange.code === "dst_invalid_local_time"
  ));

  // =========================
  // TIME-P1c HARDENING (final-blocker round, Blocker 3): non-1-hour DST
  // fold/gap detection (Australia/Lord_Howe, a real 30-minute DST offset
  // change — 10:30 standard to 11:00 daylight). Both dates below were
  // confirmed by directly scanning zonedWallTimeToUtcMs() across all of
  // 2026 for this zone before writing these assertions, not guessed. The
  // OLD ±60-minute-hardcoded ambiguity probe would have missed both of
  // these entirely (silently accepting an ambiguous/nonexistent time),
  // since neither transition is a 60-minute shift.
  // =========================

  let lordHoweAmbiguous: InvalidLocalWallTimeError | undefined;
  try {
    zonedWallTimeToUtcMs(2026, 4, 5, 1, 45, "Australia/Lord_Howe"); // repeated wall time across the 30-minute fall-back fold
  } catch (error) {
    if (error instanceof InvalidLocalWallTimeError) lordHoweAmbiguous = error;
  }
  results.push(check(
    "[Blocker 3] Australia/Lord_Howe's repeated 2026-04-05 01:45 (a real 30-minute DST fold, not a 60-minute one) is detected as ambiguous and fails closed",
    lordHoweAmbiguous?.reason === "ambiguous"
  ));

  let lordHoweNonexistent: InvalidLocalWallTimeError | undefined;
  try {
    zonedWallTimeToUtcMs(2026, 10, 4, 2, 15, "Australia/Lord_Howe"); // inside the 30-minute spring-forward gap
  } catch (error) {
    if (error instanceof InvalidLocalWallTimeError) lordHoweNonexistent = error;
  }
  results.push(check(
    "[Blocker 3] Australia/Lord_Howe's nonexistent 2026-10-04 02:15 (a real 30-minute DST gap) is detected as nonexistent and fails closed",
    lordHoweNonexistent?.reason === "nonexistent"
  ));

  results.push(check(
    "[Blocker 3] an ordinary Lord_Howe wall time well outside either transition resolves normally, without falsely flagging every date in this zone",
    (() => {
      try {
        zonedWallTimeToUtcMs(2026, 6, 15, 9, 0, "Australia/Lord_Howe");
        return true;
      } catch {
        return false;
      }
    })()
  ));

  // =========================
  // TIME-P1c HARDENING (final-blocker round, Blocker 2): pure
  // local-calendar-date arithmetic (addCalendarDays), independent of the
  // slot engine — see also tests/tact/work/calendarSlotEngine.test.ts for
  // the end-to-end candidate-generation coverage across these same
  // boundaries.
  // =========================

  results.push(check(
    "[Blocker 2] 2026-11-01 previous day -> 2026-10-31",
    JSON.stringify(addCalendarDays(2026, 11, 1, -1, "Asia/Tokyo")) === JSON.stringify({ year: 2026, month: 10, day: 31 })
  ));

  results.push(check(
    "[Blocker 2] 2026-10-31 next day -> 2026-11-01",
    JSON.stringify(addCalendarDays(2026, 10, 31, 1, "Asia/Tokyo")) === JSON.stringify({ year: 2026, month: 11, day: 1 })
  ));

  results.push(check(
    "[Blocker 2] 2027-01-01 previous day -> 2026-12-31 (year boundary)",
    JSON.stringify(addCalendarDays(2027, 1, 1, -1, "Asia/Tokyo")) === JSON.stringify({ year: 2026, month: 12, day: 31 })
  ));

  results.push(check(
    "[Blocker 2] 2028-02-28 next day -> 2028-02-29 (leap year)",
    JSON.stringify(addCalendarDays(2028, 2, 28, 1, "Asia/Tokyo")) === JSON.stringify({ year: 2028, month: 2, day: 29 })
  ));

  results.push(check(
    "[Blocker 2] 2028-02-29 next day -> 2028-03-01",
    JSON.stringify(addCalendarDays(2028, 2, 29, 1, "Asia/Tokyo")) === JSON.stringify({ year: 2028, month: 3, day: 1 })
  ));

  results.push(check(
    "[Blocker 2] 2026-02-28 next day -> 2026-03-01 (non-leap year, no Feb 29)",
    JSON.stringify(addCalendarDays(2026, 2, 28, 1, "Asia/Tokyo")) === JSON.stringify({ year: 2026, month: 3, day: 1 })
  ));

  return summarize("work/temporalHardening", results);
}
