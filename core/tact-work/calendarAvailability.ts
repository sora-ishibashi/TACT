// TACT Work — TIME-P1c: canonical, provider-neutral Calendar Availability
// model.
//
// ARCH-R3 boundary (TIME-P1c instructions Section 5): TACT Core != Google
// Calendar, TACT Core != Composio. Nothing in this file knows about a
// specific provider's response shape, tool slugs, or SDKs — it mirrors the
// existing pattern in core/tact-integration/types.ts (SlackListChannelsResult,
// GmailSearchMessagesResult, NotionSearchResult), which already establishes
// "canonical, compact, no raw provider metadata" as the house style for read
// results.
//
// Repository Reality Audit finding (recorded here for continuity): as of
// this phase, core/tact-integration/types.ts's IntegrationService is
// "slack" | "gmail" | "notion" only — no Calendar provider exists yet, and
// COMPOSIO_API_KEY was not configured in the audit environment, so whether
// Composio's Google Calendar toolkit can be constrained to read-only scope
// could not be verified (TIME-P1c instructions Section 9 requires stopping
// before introducing a write-capable integration path if this can't be
// confirmed). Per product decision, this phase builds the provider-neutral
// boundary and a Fake provider only; wiring a real Composio Calendar adapter
// is deferred to a later phase.
//
// READ ONLY (Section 9): CalendarAvailabilityProvider exposes exactly one
// method, a read. There is no insert/update/delete/invite/RSVP method on
// this interface, by construction — a provider implementing this interface
// structurally cannot be asked to write.

export interface BusyInterval {
  // ISO 8601 UTC instants (e.g. "2026-09-22T01:00:00.000Z"). Canonical
  // busy-interval semantics live entirely in UTC; wall-clock/timezone
  // presentation is a concern of the caller (slotEngine.ts / presentation
  // layer), never of this model.
  readonly startUtc: string;
  readonly endUtc: string;
}

export interface CalendarAvailabilityRequest {
  readonly rangeStartUtc: string;
  readonly rangeEndUtc: string;
  // Required, explicit, IANA identifier. There is no default here — see
  // core/tact-work/timezone.ts's isKnownTimeZone() and Section 7's absolute
  // condition against inferring a timezone.
  readonly timezone: string;
}

// Section 16 (Multiple calendars / scope): TIME-P1c v1 only ever reads the
// authenticated user's own accessible calendar(s). "attendee" is reserved
// for a later phase (Section 17) and is intentionally not a valid value yet
// — adding it is a deliberate, separate decision, not a silent default.
export type CalendarAvailabilitySourceScope = "own_calendar";

export interface AvailabilityResult {
  readonly rangeStartUtc: string;
  readonly rangeEndUtc: string;
  readonly timezone: string;
  // Normalized (clipped/sorted/merged — see normalizeBusyIntervals below).
  readonly busyIntervals: readonly BusyInterval[];
  readonly sourceScope: CalendarAvailabilitySourceScope;
}

// Section 21 (Error handling): these must stay distinguishable from each
// other by the caller — collapsing them into one generic failure message is
// explicitly disallowed by the instructions.
export type CalendarAvailabilityErrorCode =
  | "connection_missing"
  | "permission_denied"
  | "provider_failure"
  | "malformed_response";

export interface CalendarAvailabilityError {
  readonly code: CalendarAvailabilityErrorCode;
  readonly message: string;
}

export type CalendarAvailabilityProviderResult =
  | { readonly success: true; readonly result: AvailabilityResult }
  | { readonly success: false; readonly error: CalendarAvailabilityError };

export interface CalendarAvailabilityProvider {
  getAvailability(request: CalendarAvailabilityRequest): Promise<CalendarAvailabilityProviderResult>;
}

// =========================
// Busy interval normalization (Section 15)
// =========================
//
// Handles: clipping to the requested range, all-day/cross-midnight/
// different-offset intervals (all already reduced to UTC instants by the
// time they reach this function — that reduction is the provider adapter's
// job, not this one's), overlapping, nesting, and touching intervals.
//
// Touching intervals (one ends exactly when another starts) are merged into
// a single continuous busy block. This is a deliberate, documented choice:
// it stays consistent with the slot engine's own half-open interval
// semantics ([start, end)), where a candidate slot starting exactly at a
// busy interval's end is free (Section 25 required test 3) — merging
// touching intervals does not change that boundary, it only collapses two
// adjacent busy blocks into one for simpler downstream reasoning.
export function normalizeBusyIntervals(
  intervals: readonly BusyInterval[],
  rangeStartUtc: string,
  rangeEndUtc: string
): BusyInterval[] {

  const rangeStart = Date.parse(rangeStartUtc);
  const rangeEnd = Date.parse(rangeEndUtc);

  const clipped = intervals
    .map((interval) => ({
      start: Math.max(Date.parse(interval.startUtc), rangeStart),
      end: Math.min(Date.parse(interval.endUtc), rangeEnd),
    }))
    // Drops malformed (NaN) or empty/inverted intervals defensively rather
    // than letting them corrupt sort/merge — a provider adapter bug should
    // never silently create a negative-duration or NaN-bounded busy block.
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];

  for (const interval of clipped) {

    const last = merged[merged.length - 1];

    if (last && interval.start <= last.end) {
      // Overlapping, nested, or touching — extend the open block.
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }

  }

  return merged.map((interval) => ({
    startUtc: new Date(interval.start).toISOString(),
    endUtc: new Date(interval.end).toISOString(),
  }));

}

// =========================
// TIME-P1c HARDENING (Blocker F / Section 7-8): provider-neutral,
// independent fail-closed validation
// =========================
//
// The real Composio adapter's own normalizer (mappings/googleCalendar.ts)
// already fails closed on malformed data — but this canonical Foundation
// layer must not simply trust ANY CalendarAvailabilityProvider implementer
// (present or future) to have been equally careful. This function is the
// second, independent gate that core/tact-work/candidateSchedule.ts runs on
// every provider result BEFORE normalizeBusyIntervals() above (whose
// clip/merge/sort job assumes its input already passed this check).
//
// Absolute condition: a malformed busy interval is never dropped here —
// false availability (a real busy period silently vanishing because it
// failed to parse) is strictly worse than refusing to answer, so exactly
// one malformed interval fails validation for the ENTIRE result, not just
// that one entry. Also checks sourceScope AT RUNTIME rather than trusting
// the CalendarAvailabilitySourceScope compile-time type (Section 8: "Do not
// trust TypeScript compile-time typing alone" — a provider is ordinary
// JavaScript at runtime and can return any string).
export type AvailabilityResultValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly message: string };

const SUPPORTED_SOURCE_SCOPES: ReadonlySet<string> = new Set<CalendarAvailabilitySourceScope>(["own_calendar"]);

export function validateAvailabilityResult(result: AvailabilityResult): AvailabilityResultValidation {

  if (typeof result.rangeStartUtc !== "string" || !Number.isFinite(Date.parse(result.rangeStartUtc))) {
    return { valid: false, message: "rangeStartUtc is not a valid instant." };
  }

  if (typeof result.rangeEndUtc !== "string" || !Number.isFinite(Date.parse(result.rangeEndUtc))) {
    return { valid: false, message: "rangeEndUtc is not a valid instant." };
  }

  if (Date.parse(result.rangeEndUtc) <= Date.parse(result.rangeStartUtc)) {
    return { valid: false, message: "rangeEndUtc is not after rangeStartUtc." };
  }

  if (typeof result.timezone !== "string" || result.timezone.length === 0) {
    return { valid: false, message: "timezone is missing or empty." };
  }

  if (!SUPPORTED_SOURCE_SCOPES.has(result.sourceScope)) {
    return { valid: false, message: `Unsupported sourceScope: ${JSON.stringify(result.sourceScope)}.` };
  }

  if (!Array.isArray(result.busyIntervals)) {
    return { valid: false, message: "busyIntervals is not an array." };
  }

  for (const interval of result.busyIntervals) {

    if (!interval || typeof interval !== "object") {
      return { valid: false, message: "A busy interval is not an object." };
    }

    if (typeof interval.startUtc !== "string" || typeof interval.endUtc !== "string") {
      return { valid: false, message: "A busy interval's start/end is not a string." };
    }

    const start = Date.parse(interval.startUtc);
    const end = Date.parse(interval.endUtc);

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { valid: false, message: "A busy interval has an unparseable timestamp." };
    }

    if (end <= start) {
      return { valid: false, message: "A busy interval's end is not strictly after its start." };
    }

  }

  return { valid: true };

}

// =========================
// Fake provider (Section 24: no live Calendar access in tests)
// =========================
//
// Deterministic, in-memory CalendarAvailabilityProvider for unit/contract
// tests and for the Reality Test (Section 26). A real Composio Google
// Calendar adapter can be added later as an alternate implementation of the
// same interface without this model or the slot engine changing.
export interface FakeCalendarAvailabilityProviderConfig {
  readonly busyIntervals?: readonly BusyInterval[];
  readonly error?: CalendarAvailabilityError;
  // Lets tests exercise the "malformed_response" path without hand-rolling
  // a second provider implementation.
  readonly respondWithMalformedResult?: boolean;
  // TIME-P1c HARDENING (Blocker F, hostile Reality Test cases, Section 15):
  // when true, `busyIntervals` is returned exactly as given, skipping this
  // provider's own normalizeBusyIntervals() call — simulating a provider
  // that returns malformed/inverted busy data directly, so tests can
  // confirm the provider-neutral Foundation (candidateSchedule.ts's
  // validateAvailabilityResult()) independently catches it rather than
  // relying on every provider to have sanitized its own output first.
  readonly bypassNormalization?: boolean;
  // Lets tests construct a runtime-invalid sourceScope (Section 8: runtime
  // validation must not trust the compile-time type alone) without needing
  // a second provider implementation.
  readonly sourceScope?: CalendarAvailabilitySourceScope;
}

export function createFakeCalendarAvailabilityProvider(
  config: FakeCalendarAvailabilityProviderConfig = {}
): CalendarAvailabilityProvider {

  return {

    async getAvailability(request: CalendarAvailabilityRequest): Promise<CalendarAvailabilityProviderResult> {

      if (config.error) {
        return { success: false, error: config.error };
      }

      if (config.respondWithMalformedResult) {
        return {
          success: false,
          error: { code: "malformed_response", message: "Provider response did not match the expected shape." },
        };
      }

      return {
        success: true,
        result: {
          rangeStartUtc: request.rangeStartUtc,
          rangeEndUtc: request.rangeEndUtc,
          timezone: request.timezone,
          busyIntervals: config.bypassNormalization
            ? (config.busyIntervals ?? [])
            : normalizeBusyIntervals(config.busyIntervals ?? [], request.rangeStartUtc, request.rangeEndUtc),
          sourceScope: config.sourceScope ?? "own_calendar",
        },
      };

    },

  };

}
