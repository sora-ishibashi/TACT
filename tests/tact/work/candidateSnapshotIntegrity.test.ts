import { toCandidateSlotSnapshotMetadata, readCandidateSlotSnapshotMetadata, type ToCandidateSlotSnapshotMetadataParams } from "../../../core/tact-work/candidateSchedule";
import type { CandidateSlot, DailyWindow } from "../../../core/tact-work/slotEngine";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c HARDENING — Blocker E: candidate snapshot immutability and
// deterministic integrity hashing.

function makeCandidates(): CandidateSlot[] {
  return [
    { index: 1, startUtc: "2026-09-21T01:00:00.000Z", endUtc: "2026-09-21T01:30:00.000Z", timezone: "Asia/Tokyo" },
    { index: 2, startUtc: "2026-09-21T01:15:00.000Z", endUtc: "2026-09-21T01:45:00.000Z", timezone: "Asia/Tokyo" },
    { index: 3, startUtc: "2026-09-21T01:30:00.000Z", endUtc: "2026-09-21T02:00:00.000Z", timezone: "Asia/Tokyo" },
  ];
}

function makeDailyWindow(): DailyWindow {
  return { startMinuteOfDay: 540, endMinuteOfDay: 1080 };
}

function baseParams(): ToCandidateSlotSnapshotMetadataParams {
  return {
    candidates: makeCandidates(),
    generatedAtUtc: "2026-09-14T00:00:00.000Z",
    sourceScope: "own_calendar",
    resolvedRange: { startUtc: "2026-09-20T15:00:00.000Z", endUtc: "2026-09-27T15:00:00.000Z" },
    timezone: "Asia/Tokyo",
    dailyWindow: makeDailyWindow(),
    candidateCount: 3,
    slotGranularityMinutes: 15,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // Deep copy / mutation resistance
  // =========================

  const originalCandidates = makeCandidates();
  const params = { ...baseParams(), candidates: originalCandidates };
  const snapshot = toCandidateSlotSnapshotMetadata(params);

  const candidateHashBeforeMutation = snapshot.candidateHash;
  const firstStartBeforeMutation = snapshot.candidates[0].startUtc;

  // Mutate the ORIGINAL array/object the caller still holds a reference to.
  originalCandidates.push({ index: 4, startUtc: "2026-09-21T02:15:00.000Z", endUtc: "2026-09-21T02:45:00.000Z", timezone: "Asia/Tokyo" });
  (originalCandidates[0] as { startUtc: string }).startUtc = "1999-01-01T00:00:00.000Z";

  results.push(check(
    "[Blocker E] mutating the original candidates array after snapshot creation does not change the snapshot's length",
    snapshot.candidates.length === 3
  ));
  results.push(check(
    "[Blocker E] mutating a nested candidate object after snapshot creation does not alter the stored snapshot",
    snapshot.candidates[0].startUtc === firstStartBeforeMutation
  ));
  results.push(check(
    "[Blocker E] the snapshot's own hash is unaffected by post-creation mutation of the caller's original array",
    snapshot.candidateHash === candidateHashBeforeMutation
  ));

  const originalDailyWindow = makeDailyWindow();
  const paramsWithSharedWindow = { ...baseParams(), dailyWindow: originalDailyWindow };
  const snapshotWithSharedWindow = toCandidateSlotSnapshotMetadata(paramsWithSharedWindow);
  (originalDailyWindow as { startMinuteOfDay: number }).startMinuteOfDay = 0;
  results.push(check(
    "[Blocker E] mutating the original dailyWindow object after snapshot creation does not alter the stored snapshot",
    snapshotWithSharedWindow.dailyWindow.startMinuteOfDay === 540
  ));

  // =========================
  // Mutation-resistant in-memory object (deep freeze)
  // =========================

  results.push(check("[Blocker E] the snapshot object itself is frozen", Object.isFrozen(snapshot)));
  results.push(check("[Blocker E] the snapshot's candidates array is frozen", Object.isFrozen(snapshot.candidates)));
  results.push(check("[Blocker E] an individual candidate slot within the snapshot is frozen", Object.isFrozen(snapshot.candidates[0])));
  results.push(check("[Blocker E] the snapshot's dailyWindow is frozen", Object.isFrozen(snapshot.dailyWindow)));

  // In non-strict-mode assignment to a frozen object silently no-ops rather
  // than throwing — either way, the value must not actually change.
  try {
    (snapshot.candidates[0] as { startUtc: string }).startUtc = "hacked";
  } catch {
    // Also acceptable: strict-mode assignment to a frozen property throws.
  }
  results.push(check(
    "[Blocker E] a direct write attempt on a frozen candidate does not change its value",
    snapshot.candidates[0].startUtc === firstStartBeforeMutation
  ));

  // =========================
  // Deterministic hashing
  // =========================

  const snapshotA = toCandidateSlotSnapshotMetadata(baseParams());
  const snapshotB = toCandidateSlotSnapshotMetadata(baseParams());

  results.push(check(
    "[Blocker E] the same canonical input yields the same requestHash across separate calls",
    snapshotA.requestHash === snapshotB.requestHash
  ));
  results.push(check(
    "[Blocker E] the same canonical input yields the same candidateHash across separate calls",
    snapshotA.candidateHash === snapshotB.candidateHash
  ));
  results.push(check(
    "[Blocker E] requestHash and candidateHash are distinct values (not accidentally the same hash reused)",
    snapshotA.requestHash !== snapshotA.candidateHash
  ));

  const differentGeneratedAt = toCandidateSlotSnapshotMetadata({ ...baseParams(), generatedAtUtc: "2099-01-01T00:00:00.000Z" });
  results.push(check(
    "[Blocker E] requestHash represents the effective request/policy, not the fetch timestamp — changing generatedAtUtc alone does not change it",
    differentGeneratedAt.requestHash === snapshotA.requestHash
  ));

  const differentWindow = toCandidateSlotSnapshotMetadata({ ...baseParams(), dailyWindow: { startMinuteOfDay: 0, endMinuteOfDay: 1440 } });
  results.push(check(
    "[Blocker E] changing dailyWindow changes requestHash",
    differentWindow.requestHash !== snapshotA.requestHash
  ));

  const differentCount = toCandidateSlotSnapshotMetadata({ ...baseParams(), candidateCount: 5 });
  results.push(check(
    "[Blocker E] changing the effective candidateCount changes requestHash",
    differentCount.requestHash !== snapshotA.requestHash
  ));

  const differentTimestampCandidates = makeCandidates();
  (differentTimestampCandidates[0] as { startUtc: string }).startUtc = "2026-09-21T01:05:00.000Z";
  const changedCandidate = toCandidateSlotSnapshotMetadata({ ...baseParams(), candidates: differentTimestampCandidates });
  results.push(check(
    "[Blocker E] changing one candidate's start time changes candidateHash",
    changedCandidate.candidateHash !== snapshotA.candidateHash
  ));

  const reorderedCandidates = [...makeCandidates()].reverse().map((slot, i) => ({ ...slot, index: i + 1 }));
  const reordered = toCandidateSlotSnapshotMetadata({ ...baseParams(), candidates: reorderedCandidates });
  results.push(check(
    "[Blocker E] reordering the same candidates changes candidateHash (order is semantically significant)",
    reordered.candidateHash !== snapshotA.candidateHash
  ));

  // =========================
  // Round-trip / version guard
  // =========================

  const roundTripped = readCandidateSlotSnapshotMetadata({ calendarCandidateSnapshot: snapshotA });
  results.push(check(
    "[Blocker E] a version-2 snapshot round-trips through Work.metadata with hashes intact",
    roundTripped?.requestHash === snapshotA.requestHash && roundTripped?.candidateHash === snapshotA.candidateHash
  ));

  results.push(check(
    "[Blocker E] a pre-hardening version-1 shaped value is rejected, never partially trusted",
    readCandidateSlotSnapshotMetadata({
      calendarCandidateSnapshot: { version: 1, generatedAtUtc: "2026-09-14T00:00:00.000Z", sourceScope: "own_calendar", candidates: makeCandidates() },
    }) === undefined
  ));

  // =========================
  // TIME-P1c HARDENING (final-blocker round, Section 12): snapshot reader
  // hash validation — a value with the CORRECT shape but a tampered/
  // corrupted/hand-edited field must still be rejected, not just a
  // wrong-type value.
  // =========================

  results.push(check(
    "[Section 12] a snapshot whose stored candidateHash does not match its actual candidates (e.g. a hand-edited startUtc) is rejected outright",
    readCandidateSlotSnapshotMetadata({
      calendarCandidateSnapshot: {
        ...snapshotA,
        candidates: [{ ...snapshotA.candidates[0], startUtc: "1999-01-01T00:00:00.000Z" }, ...snapshotA.candidates.slice(1)],
        // candidateHash left as-is from snapshotA -> now stale/mismatched
      },
    }) === undefined
  ));

  results.push(check(
    "[Section 12] a snapshot whose stored requestHash does not match its actual policy fields (e.g. a hand-edited candidateCount) is rejected outright",
    readCandidateSlotSnapshotMetadata({
      calendarCandidateSnapshot: {
        ...snapshotA,
        candidateCount: 999,
        // requestHash left as-is from snapshotA -> now stale/mismatched
      },
    }) === undefined
  ));

  results.push(check(
    "[Section 12] an untampered snapshot (hashes genuinely match its own fields) still reads back successfully — the new check does not false-positive",
    readCandidateSlotSnapshotMetadata({ calendarCandidateSnapshot: snapshotA }) !== undefined
  ));

  // =========================
  // Section 11 / Section 23-24: Work.metadata persistence — same
  // source-inspection technique already established for
  // updateWorkTemporalRequirementMetadata() by
  // tests/tact/work/temporalRequirements.test.ts (this repository's
  // accepted pattern for these narrow, DB-touching store.ts writers, which
  // are not otherwise mocked/exercised end-to-end in this suite).
  // =========================

  const storeSource = readFileSync(join(__dirname, "..", "..", "..", "core", "tact-work", "store.ts"), "utf8");
  const candidateSnapshotWriter = storeSource.slice(
    storeSource.indexOf("export async function updateWorkCandidateSnapshotMetadata"),
    storeSource.indexOf("export interface CreateWorkTaskParams")
  );
  results.push(check(
    "[Blocker E] updateWorkCandidateSnapshotMetadata() preserves unrelated Work.metadata (spreads the existing object rather than replacing it) and guards against concurrent writes via updated_at",
    candidateSnapshotWriter.includes("...(work.metadata ?? {})") &&
      candidateSnapshotWriter.includes("calendarCandidateSnapshot") &&
      candidateSnapshotWriter.includes('.eq("updated_at", work.updatedAt)')
  ));

  return summarize("work/candidateSnapshotIntegrity", results);
}
