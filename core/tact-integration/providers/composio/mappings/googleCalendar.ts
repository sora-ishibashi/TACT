import type { BusyInterval, CalendarAvailabilityErrorCode } from "../../../../tact-work/calendarAvailability";
import { isExplicitUtcInstant } from "../../../../tact-work/timezone";
import { normalizeComposioError } from "../adapter";
import { EXPECTED_ENVELOPE_KIND, GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT } from "./googleCalendarFindFreeSlotsContract";

// =========================
// TACT Integration — Composio Google Calendar Availability Mapper/Normalizer
// (TIME-P1c Section 7-9; HARDENING Codex delta-fix Sections 1/2/3/6;
// final-blocker round Section 11)
// =========================
//
// Schema/version pinning status (Section 11, final-blocker round): the
// Composio SDK's tools.execute() DOES accept an explicit `version`
// parameter (core/tact-integration/providers/composio/googleCalendarAvailabilityProvider.ts
// passes one), so pinning is technically possible — but the RUNTIME DEFAULT
// (getGoogleCalendarToolkitVersion() in ./client.ts, used when
// COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION is unset) stays "latest",
// unchanged, matching the exact same established default already used for
// Slack/Gmail/Notion. Hardcoding the verifiedAtToolkitVersion recorded in
// the contract fixture as the default is deliberately NOT done here: unlike
// an opt-in override, a hardcoded historical default could silently break
// if Composio ever retires that dated version, trading one drift risk for
// another rather than removing it. What actually protects against schema
// drift, regardless of which toolkit version ends up in effect, is this
// file's OWN strict envelope/normalizer validation (Section 2/9) — any
// response shape that doesn't match the verified contract fails closed as
// malformed_response rather than being silently trusted. An operator who
// wants a specific version pinned can still set
// COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION explicitly.
//
// Schema verification (Section 7): this slug and the exact shapes below were
// retrieved live from Composio's tool metadata endpoint
// (client.tools.getRawComposioToolBySlug("GOOGLECALENDAR_FIND_FREE_SLOTS"))
// on 2026-09-14, current pinned version "20260902_00" at that time. This is
// a metadata/schema lookup only — it does not execute the tool and does not
// touch any user's actual Google Calendar. DO NOT GUESS at this shape if it
// ever needs re-verifying; re-run the same metadata lookup. The full
// sanitized contract (field names/types/descriptions only — no
// credentials, tokens, account IDs, or Calendar data) is committed at
// ./googleCalendarFindFreeSlotsContract.ts so a reviewer can audit this
// file against it without needing to re-run that lookup themselves.
//
// This file is the ONLY place in the codebase that names this slug or knows
// this response shape (Section 8/9: strict mapper, strict normalizer — no
// other file constructs Composio Calendar arguments or parses its output).
//
// TIME-P1c HARDENING FIX (final-blocker round, Section 11 — schema pinning
// debt): re-exported directly from the committed contract
// (googleCalendarFindFreeSlotsContract.ts) rather than redeclared as a
// second literal, so the slug this file actually calls and the slug the
// contract documents cannot silently drift apart — same principle already
// applied to EXPECTED_ENVELOPE_KIND below.
export const GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG: string = GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.slug;

// TIME-P1c HARDENING FIX (Codex delta-fix, arbitrary-calendar-target
// blocker): the calendar identifier queried is now a single, internal,
// non-exported, non-parameterized constant — "primary" (the verified
// schema's own conceptual name for the authenticated user's main calendar;
// see the contract fixture in ./googleCalendarFindFreeSlotsContract.ts).
// Neither mapToGoogleCalendarFindFreeSlotsInput() nor
// normalizeGoogleCalendarFindFreeSlotsOutput() below accepts a calendarId
// parameter at all — there is structurally no argument through which a
// caller, an LLM, a TemporalRequirement field, or Work metadata could ever
// supply "attendee@example.com" or any other calendar identifier. This is
// what makes `sourceScope: "own_calendar"` true BY CONSTRUCTION rather than
// by convention (Section 1/10/16/17: attendee availability is out of scope
// for TIME-P1c v1, and this file cannot be used to query anyone else's
// calendar even by caller error).
const PRIMARY_CALENDAR_ID = "primary";

// =========================
// Canonical -> Composio input (Section 8: fixed READ binding)
// =========================
//
// Verified required/optional input fields (all optional per schema, but
// this mapper always supplies time_min/time_max/timezone explicitly rather
// than relying on any of Composio's own defaults — Composio's own
// documented default for an omitted time_min/time_max is "the current
// timestamp", which is exactly the implicit-now dependency TIME-P1c's
// timezone/range resolution (core/tact-work/temporalRange.ts) exists to
// avoid):
//   items: string[] (default ["primary"])
//   time_min: string (ISO 8601 accepted)
//   time_max: string (ISO 8601 accepted, exclusive)
//   timezone: string (IANA; default "UTC" — never relied upon here)
//   group_expansion_max / calendar_expansion_max: left at Composio's own
//     defaults (100 / 50) — irrelevant to a single fixed "primary" query.
//
// This object literal has exactly these four keys, always. Nothing here is
// ever derived from an LLM output, a free-form user string, or a
// dynamically-constructed field name (Section 8 absolute condition).
export interface GoogleCalendarFindFreeSlotsInput {
  readonly items: readonly string[];
  readonly time_min: string;
  readonly time_max: string;
  readonly timezone: string;
  // Composio's tools.execute() takes an untyped Record<string, unknown> for
  // `arguments` — this index signature is only a structural-compatibility
  // shim for that boundary; it does not widen what this mapper actually
  // emits (still exactly the four named fields above, always).
  readonly [key: string]: unknown;
}

// Section 16/10 (attendee honesty, structural enforcement): this mapper
// takes no calendarId parameter at all — it always emits exactly
// PRIMARY_CALENDAR_ID, TACT's own accessible calendar. There is no
// argument here through which a third party's calendar could be requested,
// even by caller error; that would require a different, not-yet-built,
// explicitly-named attendee-availability entry point (Section 17, not
// implemented in TIME-P1c v1).
export function mapToGoogleCalendarFindFreeSlotsInput(
  request: { readonly rangeStartUtc: string; readonly rangeEndUtc: string; readonly timezone: string }
): GoogleCalendarFindFreeSlotsInput {

  return {
    items: [PRIMARY_CALENDAR_ID],
    time_min: request.rangeStartUtc,
    time_max: request.rangeEndUtc,
    timezone: request.timezone,
  };

}

// =========================
// Composio output -> Canonical (Section 9: strict normalizer)
// =========================
//
// Verified output shape:
//   { data: { kind, timeMin, timeMax, calendars?: { [id]: CalendarWindow } },
//     error?: string, successful: boolean }
//   CalendarWindow: { busy: {start,end}[], free: {start,end}[], is_reliable?: boolean }
//
// Absolute condition (Section 9): success never falls through to a generic
// `result.data` passthrough. Every field this function reads is checked by
// a runtime type guard; anything that does not match is malformed_response,
// never a best-effort partial parse (a partially-trusted busy list could
// silently under-report a busy interval as free, which is worse than
// refusing to answer).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// TIME-P1c HARDENING FIX (final-blocker round, Blocker 1 — Codex-reproduced
// false-free-time path): this previously validated only that `start`/`end`
// were STRINGS — a raw busy period like {start: "not-an-instant", end:
// "2026-09-21T01:00:00Z"} passed this check, produced a canonical
// BusyInterval carrying the unparseable string, and only got caught (and
// SILENTLY DROPPED, not failed) two layers downstream by
// calendarAvailability.ts's normalizeBusyIntervals() — which is a
// second-line, provider-neutral defense, not a schema validator. The net
// effect: a malformed Google busy period could vanish and the affected time
// window would be reported free. Provider-specific schema validation
// belongs HERE, at the adapter boundary, before a canonical BusyInterval is
// ever constructed. Every entry must now have a start/end that:
//   - is present and a string
//   - is an explicit absolute instant (contains "Z" or a numeric ±HH:MM
//     offset — isExplicitUtcInstant(), the same helper that already
//     protects reference-instant parsing in core/tact-work/timezone.ts)
//   - parses to a finite instant (redundant with the above by construction,
//     kept as an explicit assertion for readability)
//   - has end strictly after start (rejects reversed AND zero-length)
// A single malformed period still fails the ENTIRE parse (returns
// undefined) rather than being dropped and continuing.
function isValidAbsoluteInstant(value: unknown): value is string {
  return typeof value === "string" && isExplicitUtcInstant(value) && Number.isFinite(Date.parse(value));
}

function parseBusyIntervals(value: unknown): BusyInterval[] | undefined {

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed: BusyInterval[] = [];

  for (const entry of value) {

    if (!isRecord(entry)) {
      return undefined;
    }

    if (!isValidAbsoluteInstant(entry.start) || !isValidAbsoluteInstant(entry.end)) {
      return undefined;
    }

    if (Date.parse(entry.end) <= Date.parse(entry.start)) {
      return undefined;
    }

    parsed.push({ startUtc: entry.start, endUtc: entry.end });

  }

  return parsed;

}

export type GoogleCalendarFindFreeSlotsNormalizedResult =
  | {
      readonly success: true;
      readonly busyIntervals: readonly BusyInterval[];
    }
  | {
      readonly success: false;
      readonly errorCode: CalendarAvailabilityErrorCode;
      readonly message: string;
    };

// TIME-P1c HARDENING FIX (Codex delta-fix Section 2, provider envelope
// validation): the verified contract (googleCalendarFindFreeSlotsContract.ts)
// requires "kind", "timeMin", and "timeMax" on FindFreeSlotsResponse — this
// normalizer previously read straight through to "calendars" without ever
// checking any of the three, so a response with the right calendars shape
// but a wrong/mutated envelope (e.g. a completely different "kind", or a
// timeMin/timeMax that silently doesn't match what was actually requested —
// a sign the request itself may not have been honored) would have been
// accepted at face value. All three are now validated before "calendars" is
// ever read, and timeMin/timeMax are compared to the ACTUAL requested range
// (by parsed instant, not string equality, since a provider may legitimately
// reformat an equivalent ISO timestamp).
function validateEnvelope(
  data: Record<string, unknown>,
  expectedRange: { readonly rangeStartUtc: string; readonly rangeEndUtc: string }
): { readonly valid: true } | { readonly valid: false; readonly message: string } {

  if (data.kind !== EXPECTED_ENVELOPE_KIND) {
    return { valid: false, message: `Envelope "kind" was ${JSON.stringify(data.kind)}, expected ${JSON.stringify(EXPECTED_ENVELOPE_KIND)}.` };
  }

  if (typeof data.timeMin !== "string" || !Number.isFinite(Date.parse(data.timeMin))) {
    return { valid: false, message: "Envelope \"timeMin\" is missing or unparseable." };
  }

  if (typeof data.timeMax !== "string" || !Number.isFinite(Date.parse(data.timeMax))) {
    return { valid: false, message: "Envelope \"timeMax\" is missing or unparseable." };
  }

  if (Date.parse(data.timeMin) !== Date.parse(expectedRange.rangeStartUtc)) {
    return { valid: false, message: "Envelope \"timeMin\" does not match the requested range start — the provider may not have honored the request." };
  }

  if (Date.parse(data.timeMax) !== Date.parse(expectedRange.rangeEndUtc)) {
    return { valid: false, message: "Envelope \"timeMax\" does not match the requested range end — the provider may not have honored the request." };
  }

  return { valid: true };

}

export function normalizeGoogleCalendarFindFreeSlotsOutput(
  rawOutput: unknown,
  expectedRange: { readonly rangeStartUtc: string; readonly rangeEndUtc: string }
): GoogleCalendarFindFreeSlotsNormalizedResult {

  if (!isRecord(rawOutput)) {
    return { success: false, errorCode: "malformed_response", message: "Composio response was not an object." };
  }

  if (rawOutput.successful !== true) {
    return {
      success: false,
      errorCode: "provider_failure",
      message: typeof rawOutput.error === "string" ? rawOutput.error : "Composio reported the free/busy query as unsuccessful.",
    };
  }

  if (!isRecord(rawOutput.data)) {
    return { success: false, errorCode: "malformed_response", message: "Composio response was missing the \"data\" envelope." };
  }

  const envelope = validateEnvelope(rawOutput.data, expectedRange);

  if (!envelope.valid) {
    return { success: false, errorCode: "malformed_response", message: envelope.message };
  }

  if (!isRecord(rawOutput.data.calendars)) {
    return {
      success: false,
      errorCode: "malformed_response",
      message: "Composio response was missing calendar free/busy data (\"data.calendars\").",
    };
  }

  // TIME-P1c HARDENING FIX (Codex delta-fix Section 1, arbitrary-calendar-
  // target blocker): this ALWAYS reads exactly PRIMARY_CALENDAR_ID — there
  // is no calendarId parameter on this function for a caller to override,
  // so `sourceScope: "own_calendar"` (set by the caller, googleCalendarAvailabilityProvider.ts)
  // is true by construction, not by convention.
  const calendarWindow = rawOutput.data.calendars[PRIMARY_CALENDAR_ID];

  if (!isRecord(calendarWindow)) {
    // TIME-P1c HARDENING (Codex delta-fix Section 6, reliability/error
    // semantics): an entirely ABSENT calendar entry is a structurally
    // different signal than the documented is_reliable mechanism below —
    // see googleCalendarFindFreeSlotsContract.ts's reliabilitySemantics —
    // so it is kept distinct as malformed_response rather than assumed to
    // share is_reliable:false's permission_denied cause.
    return {
      success: false,
      errorCode: GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.reliabilitySemantics.calendarEntryMissingEntirely,
      message: `Calendar "${PRIMARY_CALENDAR_ID}" was not returned by the provider at all.`,
    };
  }

  if (calendarWindow.is_reliable === false) {
    // TIME-P1c HARDENING (Codex delta-fix Section 6): grounded in the
    // contract's own is_reliable description ("Set to False when the
    // calendar query encountered errors (e.g., notFound, forbidden)") —
    // both documented causes are access-related, and the ONE calendar TACT
    // ever queries is the connected account's own "primary" calendar, so
    // this maps to permission_denied. This must never become
    // no_availability — that would falsely assert a confirmed, empty
    // result from data the provider itself flagged as unreliable.
    return {
      success: false,
      errorCode: GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.reliabilitySemantics.isReliableFalse,
      message: `Calendar "${PRIMARY_CALENDAR_ID}" free/busy data was reported unreliable by the provider.`,
    };
  }

  const busyIntervals = parseBusyIntervals(calendarWindow.busy);

  if (!busyIntervals) {
    return {
      success: false,
      errorCode: "malformed_response",
      message: `Calendar "${PRIMARY_CALENDAR_ID}" busy period data did not match the expected shape.`,
    };
  }

  return { success: true, busyIntervals };

}

// =========================
// Composio SDK error -> CalendarAvailabilityErrorCode
// =========================
//
// Reuses the existing, already-tested normalizeComposioError() (adapter.ts)
// rather than re-deriving a second Composio-error classification — that
// function's IntegrationErrorCode taxonomy is narrowed here to this
// module's smaller, read-only-scoped CalendarAvailabilityErrorCode.
export function mapComposioErrorToCalendarAvailabilityErrorCode(error: unknown): { code: CalendarAvailabilityErrorCode; message: string } {

  const normalized = normalizeComposioError(error);

  switch (normalized.code) {
    case "connection_missing":
      return { code: "connection_missing", message: normalized.message };
    case "authorization_denied":
    case "authentication_error":
      return { code: "permission_denied", message: normalized.message };
    case "invalid_action":
    case "provider_execution_failed":
    case "temporary_failure":
      return { code: "provider_failure", message: normalized.message };
  }

}
