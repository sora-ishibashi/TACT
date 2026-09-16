// TACT Work — TIME-P1c: orchestrates
//   TemporalRequirement -> Availability Request -> Provider (READ) ->
//   Canonical Busy Intervals -> Slot Engine -> Candidate Slots -> result
//
// This is intentionally NOT wired into core/tact-conversation/orchestration.ts's
// live Slack/chat turn flow yet (per product decision — TIME-P1c ships the
// provider-neutral foundation with a Fake provider first; real Composio
// Google Calendar wiring, and the Capability Registry / decomposer / rule
// router changes needed to route a live request here, are deferred to a
// later phase). This file is a pure, fully unit-testable entry point that a
// later wiring phase can call directly.
//
// READ ONLY / NO APPROVAL (Section 22): this function never calls anything
// that writes to a calendar, never creates a TACT Approval, and candidate
// generation alone never books anything — CalendarAvailabilityProvider
// structurally has no write method (calendarAvailability.ts), and nothing
// here calls core/tact-work/approval.ts.

import type { TemporalRequirement } from "./temporalRequirements";
import { resolveTemporalDateRange, type ResolvedTemporalRange } from "./temporalRange";
import {
  normalizeBusyIntervals,
  validateAvailabilityResult,
  type CalendarAvailabilityProvider,
  type CalendarAvailabilitySourceScope,
} from "./calendarAvailability";
import {
  generateCandidateSlots,
  DEFAULT_CANDIDATE_COUNT,
  CANDIDATE_SLOT_GRANULARITY_MINUTES,
  type CandidateSlot,
  type DailyWindow,
} from "./slotEngine";
import { isKnownTimeZone } from "./timezone";
import { createHash } from "node:crypto";

// =========================
// Clarification-answer parsers (TIME-P1c only)
// =========================
//
// Deliberately separate from core/tact-work/temporalRequirements.ts's own
// extractTemporalRequirement(): timezone and daily-window are never inferred
// from the original free-text request (Section 7/12 absolute conditions),
// only from a direct answer to a Clarification this module itself asks. Both
// parsers fail closed (return undefined) rather than guess.

// Accepts only an exact IANA identifier the runtime itself recognizes (e.g.
// "Asia/Tokyo"). Never derives a timezone from a city name, abbreviation
// (e.g. "JST"), or offset (e.g. "+09:00") — those are all forms of guessing.
export function extractTimezoneAnswer(input: string): string | undefined {
  const trimmed = input.trim();
  return trimmed && isKnownTimeZone(trimmed) ? trimmed : undefined;
}

const DAILY_WINDOW_PATTERN = /([01]?\d|2[0-3]):([0-5]\d)\s*(?:〜|～|-|–|to)\s*([01]?\d|2[0-3]):([0-5]\d)/;
const MINUTES_PER_DAY = 24 * 60;

// TIME-P1c HARDENING FIX (final-blocker round, Blocker 4 — Codex-reproduced
// rejection of normal conversational overnight input): this previously
// rejected outright whenever the parsed end-of-day minute was not strictly
// greater than the start ("22:00-02:00" -> startMinuteOfDay=1320,
// endMinuteOfDay=120, and 120 > 1320 is false), even though
// core/tact-work/slotEngine.ts's DailyWindow contract has always supported
// an overnight window via endMinuteOfDay >= 1440 (see its own doc comment)
// — this function just never produced that shape from ordinary user input.
// A raw end-of-day minute at or before the start is now interpreted as
// "the next local day", matching how a person actually reads "22:00-02:00":
// startMinuteOfDay=1320, endMinuteOfDay=1560 (120 + 1440).
//
// Zero-length input ("22:00-22:00") is deliberately EXCLUDED from this
// reinterpretation and fails closed instead — silently treating it as an
// implicit 24-hour window would be exactly the kind of hidden
// business-hours assumption Section 9's absolute condition forbids; if the
// user meant a full day, they must say so some other way (this module
// never invents that meaning on their behalf).
export function extractDailyWindowAnswer(input: string): DailyWindow | undefined {

  const match = input.match(DAILY_WINDOW_PATTERN);

  if (!match) {
    return undefined;
  }

  const startMinuteOfDay = Number(match[1]) * 60 + Number(match[2]);
  const rawEndMinuteOfDay = Number(match[3]) * 60 + Number(match[4]);

  if (rawEndMinuteOfDay === startMinuteOfDay) {
    return undefined;
  }

  const endMinuteOfDay = rawEndMinuteOfDay > startMinuteOfDay
    ? rawEndMinuteOfDay
    : rawEndMinuteOfDay + MINUTES_PER_DAY;

  return { startMinuteOfDay, endMinuteOfDay };

}

// =========================
// Candidate snapshot persistence (Section 19/23; TIME-P1c HARDENING
// Blocker E: immutability + integrity)
// =========================
//
// Mirrors core/tact-work/temporalRequirements.ts's
// toTemporalRequirementMetadata()/readTemporalRequirementMetadata() pattern:
// a versioned, defensively-validated shape stored under its own
// Work.metadata key, so a later "2番で" reference resolves against exactly
// the snapshot originally shown (Section 19 — TOCTOU-safe pinning) rather
// than a silently recomputed, possibly-different set of candidates.
//
// Version 2 (HARDENING): carries every fact needed to audit/reproduce a
// generation decision (resolved range, timezone, dailyWindow, effective
// candidateCount/granularity, fetchedAt) plus two deterministic SHA-256
// integrity hashes — requestHash (the effective scheduling request/policy)
// and candidateHash (the exact ordered candidate set). Uses Node's built-in
// crypto module only; no hashing dependency was added. A version-1 snapshot
// (pre-hardening) fails readCandidateSlotSnapshotMetadata()'s validation
// below and is treated as absent, never partially trusted.

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deterministic serialization (Section 10 absolute condition): recursively
// sorts object keys before stringifying, so the result never depends on
// property insertion order — plain JSON.stringify() is NOT used for hashing
// for exactly this reason. Array order is preserved as-is (candidate order
// is semantically significant and must affect the hash).
function canonicalStringify(value: unknown): string {

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;

}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Canonical deep copy (Section 9 absolute condition): every nested
// structure snapshotted here is plain JSON-safe data (strings/numbers), so
// a JSON round-trip is a complete, safe deep copy — no shared references
// back to a caller's original objects survive. Deep-freezes the result so
// an accidental in-process mutation of the stored snapshot throws (or is a
// silent no-op in non-strict contexts) rather than corrupting pinned data.
function deepFreezeClone<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  deepFreezeInPlace(clone);
  return clone;
}

function deepFreezeInPlace(value: unknown): void {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeInPlace(nested);
    }
    Object.freeze(value);
  }
}

export interface CandidateSlotSnapshotMetadata {
  readonly version: 2;
  // The referenceInstantUtc this snapshot was generated against — not a
  // freshness guarantee (Section 20: a candidate generated at T1 may no
  // longer be free at T2), just an audit trail of when it was produced.
  readonly generatedAtUtc: string;
  readonly resolvedRange: { readonly startUtc: string; readonly endUtc: string };
  readonly timezone: string;
  readonly dailyWindow: DailyWindow;
  readonly candidateCount: number;
  readonly slotGranularityMinutes: number;
  readonly sourceScope: CalendarAvailabilitySourceScope;
  readonly candidates: readonly CandidateSlot[];
  readonly requestHash: string;
  readonly candidateHash: string;
}

export interface ToCandidateSlotSnapshotMetadataParams {
  readonly candidates: readonly CandidateSlot[];
  readonly generatedAtUtc: string;
  readonly sourceScope: CalendarAvailabilitySourceScope;
  readonly resolvedRange: { readonly startUtc: string; readonly endUtc: string };
  readonly timezone: string;
  readonly dailyWindow: DailyWindow;
  readonly candidateCount: number;
  readonly slotGranularityMinutes: number;
}

interface RequestHashInput {
  readonly resolvedRange: { readonly startUtc: string; readonly endUtc: string };
  readonly timezone: string;
  readonly dailyWindow: DailyWindow;
  readonly candidateCount: number;
  readonly slotGranularityMinutes: number;
  readonly sourceScope: CalendarAvailabilitySourceScope;
}

// Shared by both toCandidateSlotSnapshotMetadata() (write) and
// readCandidateSlotSnapshotMetadata() (TIME-P1c HARDENING, final-blocker
// round Section 12: read-time recomputation below) — one implementation,
// so the hash a snapshot is written with and the hash it is checked against
// on read can never silently diverge.
function computeRequestHash(input: RequestHashInput): string {
  return sha256Hex(canonicalStringify(input));
}

function computeCandidateHash(candidates: readonly CandidateSlot[]): string {
  return sha256Hex(canonicalStringify(candidates));
}

export function toCandidateSlotSnapshotMetadata(
  params: ToCandidateSlotSnapshotMetadataParams
): CandidateSlotSnapshotMetadata {

  // Deep-copy every nested input FIRST: a caller mutating their own
  // original candidates array/objects after this call must never alter the
  // stored snapshot (Section 9 absolute condition — verified by dedicated
  // mutation tests).
  const candidatesCopy = deepFreezeClone(params.candidates as CandidateSlot[]);
  const resolvedRangeCopy = deepFreezeClone(params.resolvedRange as { startUtc: string; endUtc: string });
  const dailyWindowCopy = deepFreezeClone(params.dailyWindow as DailyWindow);

  const requestHash = computeRequestHash({
    resolvedRange: resolvedRangeCopy,
    timezone: params.timezone,
    dailyWindow: dailyWindowCopy,
    candidateCount: params.candidateCount,
    slotGranularityMinutes: params.slotGranularityMinutes,
    sourceScope: params.sourceScope,
  });

  const candidateHash = computeCandidateHash(candidatesCopy);

  return Object.freeze({
    version: 2 as const,
    generatedAtUtc: params.generatedAtUtc,
    resolvedRange: resolvedRangeCopy,
    timezone: params.timezone,
    dailyWindow: dailyWindowCopy,
    candidateCount: params.candidateCount,
    slotGranularityMinutes: params.slotGranularityMinutes,
    sourceScope: params.sourceScope,
    candidates: candidatesCopy,
    requestHash,
    candidateHash,
  });

}

function isCandidateSlot(value: unknown): value is CandidateSlot {
  if (!isRecordValue(value)) return false;
  return (
    typeof value.index === "number" &&
    typeof value.startUtc === "string" &&
    typeof value.endUtc === "string" &&
    typeof value.timezone === "string"
  );
}

function isDailyWindow(value: unknown): value is DailyWindow {
  return isRecordValue(value) && typeof value.startMinuteOfDay === "number" && typeof value.endMinuteOfDay === "number";
}

export function readCandidateSlotSnapshotMetadata(
  metadata: Record<string, unknown> | null | undefined
): CandidateSlotSnapshotMetadata | undefined {

  const value = metadata?.calendarCandidateSnapshot;

  if (!isRecordValue(value)) {
    return undefined;
  }

  if (
    value.version !== 2 ||
    typeof value.generatedAtUtc !== "string" ||
    !isRecordValue(value.resolvedRange) ||
    typeof value.resolvedRange.startUtc !== "string" ||
    typeof value.resolvedRange.endUtc !== "string" ||
    typeof value.timezone !== "string" ||
    !isDailyWindow(value.dailyWindow) ||
    typeof value.candidateCount !== "number" ||
    typeof value.slotGranularityMinutes !== "number" ||
    value.sourceScope !== "own_calendar" ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(isCandidateSlot) ||
    typeof value.requestHash !== "string" ||
    typeof value.candidateHash !== "string"
  ) {
    return undefined;
  }

  const resolvedRange = { startUtc: value.resolvedRange.startUtc, endUtc: value.resolvedRange.endUtc };
  const dailyWindow = { startMinuteOfDay: value.dailyWindow.startMinuteOfDay, endMinuteOfDay: value.dailyWindow.endMinuteOfDay };

  // TIME-P1c HARDENING FIX (final-blocker round, Section 12: snapshot
  // reader hash validation). Structural shape validation above already
  // rejects a value that's the wrong TYPE — this additionally rejects a
  // value that has the right shape but has been tampered with, corrupted in
  // storage, or hand-edited (e.g. Work.metadata written directly rather
  // than through toCandidateSlotSnapshotMetadata()): recomputing both
  // hashes from the parsed fields and refusing to trust the stored
  // snapshot at all if either does not match. This is a narrow integrity
  // check on the fields this reader already parses — it does not attempt a
  // broader structural re-validation of every candidate field beyond what
  // isCandidateSlot() already checks (deferred, non-blocking debt).
  const recomputedRequestHash = computeRequestHash({
    resolvedRange,
    timezone: value.timezone,
    dailyWindow,
    candidateCount: value.candidateCount,
    slotGranularityMinutes: value.slotGranularityMinutes,
    sourceScope: "own_calendar",
  });

  if (recomputedRequestHash !== value.requestHash) {
    return undefined;
  }

  const recomputedCandidateHash = computeCandidateHash(value.candidates);

  if (recomputedCandidateHash !== value.candidateHash) {
    return undefined;
  }

  return {
    version: 2,
    generatedAtUtc: value.generatedAtUtc,
    resolvedRange,
    timezone: value.timezone,
    dailyWindow,
    candidateCount: value.candidateCount,
    slotGranularityMinutes: value.slotGranularityMinutes,
    sourceScope: "own_calendar",
    candidates: value.candidates,
    requestHash: value.requestHash,
    candidateHash: value.candidateHash,
  };

}

// =========================
// generateCandidateSchedule
// =========================

export type GenerateCandidateScheduleErrorCode =
  | "timezone_missing"
  | "timezone_unrecognized"
  // TIME-P1c HARDENING (Blocker C): the reference instant lacked an
  // explicit "Z"/offset marker.
  | "reference_instant_invalid"
  | "daily_window_missing"
  | "temporal_requirement_incomplete"
  // TIME-P1c HARDENING (Blocker D): the resolved date's local wall-clock
  // boundaries do not exist or are ambiguous due to a DST transition.
  | "dst_invalid_local_time"
  | "connection_missing"
  | "permission_denied"
  | "provider_failure"
  | "malformed_response"
  | "no_availability";

export interface GenerateCandidateScheduleError {
  readonly code: GenerateCandidateScheduleErrorCode;
  readonly message: string;
}

export interface GenerateCandidateScheduleSuccess {
  readonly success: true;
  readonly candidates: readonly CandidateSlot[];
  readonly snapshot: CandidateSlotSnapshotMetadata;
  readonly resolvedRange: ResolvedTemporalRange;
  readonly sourceScope: CalendarAvailabilitySourceScope;
}

export type GenerateCandidateScheduleResult =
  | GenerateCandidateScheduleSuccess
  | { readonly success: false; readonly error: GenerateCandidateScheduleError };

export interface GenerateCandidateScheduleParams {
  readonly requirement: TemporalRequirement;
  // Injected explicitly — never read from server/process time inside this
  // function or anything it calls (Section 7/8 absolute condition).
  readonly referenceInstantUtc: string;
  readonly provider: CalendarAvailabilityProvider;
  readonly granularityMinutes?: number;
}

/**
 * Validates the provider-independent portion of candidate generation.
 *
 * Callers that must not resolve a connection until a request is schedulable
 * (for example, calendar availability orchestration) use this exact temporal
 * range resolver before touching a provider boundary. The generator retains
 * its own validation as a defense in depth for its public API.
 */
export function preflightCandidateSchedule(
  params: Pick<GenerateCandidateScheduleParams, "requirement" | "referenceInstantUtc">
): { readonly success: true; readonly resolvedRange: ResolvedTemporalRange } | {
  readonly success: false;
  readonly error: GenerateCandidateScheduleError;
} {
  const { requirement } = params;

  if (!requirement.timezone) {
    return { success: false, error: { code: "timezone_missing", message: "A timezone is required." } };
  }

  if (!requirement.dailyWindow) {
    return { success: false, error: { code: "daily_window_missing", message: "A daily window is required." } };
  }

  if (!requirement.durationMinutes) {
    return { success: false, error: { code: "temporal_requirement_incomplete", message: "A duration is required." } };
  }

  const rangeResolution = resolveTemporalDateRange(
    requirement.date,
    params.referenceInstantUtc,
    requirement.timezone
  );

  if (!rangeResolution.success) {
    const errorByCode: Record<typeof rangeResolution.code, GenerateCandidateScheduleError> = {
      timezone_missing: { code: "timezone_missing", message: "A timezone is required." },
      timezone_unrecognized: { code: "timezone_unrecognized", message: "The timezone is not recognized." },
      reference_instant_invalid: { code: "reference_instant_invalid", message: "The reference instant must include an explicit offset." },
      dst_invalid_local_time: { code: "dst_invalid_local_time", message: "The requested local time is invalid or ambiguous due to DST." },
      temporal_requirement_incomplete: { code: "temporal_requirement_incomplete", message: "The temporal request is incomplete." },
    };
    return { success: false, error: errorByCode[rangeResolution.code] };
  }

  return { success: true, resolvedRange: rangeResolution.range };
}

export async function generateCandidateSchedule(
  params: GenerateCandidateScheduleParams
): Promise<GenerateCandidateScheduleResult> {

  const { requirement } = params;

  if (!requirement.timezone) {
    return { success: false, error: { code: "timezone_missing", message: "どのタイムゾーンで候補を出しますか?" } };
  }

  if (!requirement.dailyWindow) {
    return { success: false, error: { code: "daily_window_missing", message: "何時から何時の間で候補を探しますか?" } };
  }

  if (!requirement.durationMinutes) {
    return { success: false, error: { code: "temporal_requirement_incomplete", message: "会議の所要時間が確定していません。" } };
  }

  const rangeResolution = resolveTemporalDateRange(requirement.date, params.referenceInstantUtc, requirement.timezone);

  if (!rangeResolution.success) {

    if (rangeResolution.code === "timezone_missing") {
      return { success: false, error: { code: "timezone_missing", message: "どのタイムゾーンで候補を出しますか?" } };
    }

    if (rangeResolution.code === "timezone_unrecognized") {
      return { success: false, error: { code: "timezone_unrecognized", message: "指定されたタイムゾーンを認識できませんでした。" } };
    }

    if (rangeResolution.code === "reference_instant_invalid") {
      return { success: false, error: { code: "reference_instant_invalid", message: "基準時刻が明示的なタイムゾーン情報(Zまたは±HH:MM)を含んでいません。" } };
    }

    if (rangeResolution.code === "dst_invalid_local_time") {
      return { success: false, error: { code: "dst_invalid_local_time", message: "指定された日時は夏時間の切り替えにより存在しないか、一意に定まりません。" } };
    }

    return { success: false, error: { code: "temporal_requirement_incomplete", message: "候補を探す日程の範囲が確定していません。" } };

  }

  const { range } = rangeResolution;

  const providerResult = await params.provider.getAvailability({
    rangeStartUtc: range.startUtc,
    rangeEndUtc: range.endUtc,
    timezone: requirement.timezone,
  });

  if (!providerResult.success) {
    return { success: false, error: { code: providerResult.error.code, message: providerResult.error.message } };
  }

  const availability = providerResult.result;

  // TIME-P1c HARDENING (Blocker F, Section 7-8): independent, provider-
  // neutral fail-closed validation — runs BEFORE normalizeBusyIntervals()
  // below, on the provider's claimed result exactly as received. A single
  // malformed busy interval, an unsupported sourceScope, or an invalid
  // range/timezone fails the WHOLE result as malformed_response rather than
  // silently dropping the offending piece and proceeding as if it were
  // free time.
  const validation = validateAvailabilityResult(availability);

  if (!validation.valid) {
    return { success: false, error: { code: "malformed_response", message: validation.message } };
  }

  const normalizedBusyIntervals = normalizeBusyIntervals(
    availability.busyIntervals,
    availability.rangeStartUtc,
    availability.rangeEndUtc
  );

  const effectiveCandidateCount = requirement.candidateCount ?? DEFAULT_CANDIDATE_COUNT;
  const effectiveGranularityMinutes = params.granularityMinutes ?? CANDIDATE_SLOT_GRANULARITY_MINUTES;

  const candidates = generateCandidateSlots({
    rangeStartUtc: availability.rangeStartUtc,
    rangeEndUtc: availability.rangeEndUtc,
    timezone: availability.timezone,
    durationMinutes: requirement.durationMinutes,
    busyIntervals: normalizedBusyIntervals,
    dailyWindow: requirement.dailyWindow,
    candidateCount: effectiveCandidateCount,
    granularityMinutes: effectiveGranularityMinutes,
  });

  if (candidates.length === 0) {
    return {
      success: false,
      error: { code: "no_availability", message: "指定の条件では空いている候補が見つかりませんでした。" },
    };
  }

  return {
    success: true,
    candidates,
    snapshot: toCandidateSlotSnapshotMetadata({
      candidates,
      generatedAtUtc: params.referenceInstantUtc,
      sourceScope: availability.sourceScope,
      resolvedRange: { startUtc: range.startUtc, endUtc: range.endUtc },
      timezone: availability.timezone,
      dailyWindow: requirement.dailyWindow,
      candidateCount: effectiveCandidateCount,
      slotGranularityMinutes: effectiveGranularityMinutes,
    }),
    resolvedRange: range,
    sourceScope: availability.sourceScope,
  };

}
