import type { BusyInterval, CalendarAvailabilityErrorCode } from "../../../../tact-work/calendarAvailability";
import { normalizeComposioError } from "../adapter";

// =========================
// TACT Integration — Composio Google Calendar Availability Mapper/Normalizer
// (TIME-P1c Section 7-9)
// =========================
//
// Schema verification (Section 7): this slug and the exact shapes below were
// retrieved live from Composio's tool metadata endpoint
// (client.tools.getRawComposioToolBySlug("GOOGLECALENDAR_FIND_FREE_SLOTS"))
// on 2026-09-14, current pinned version "20260902_00" at that time. This is
// a metadata/schema lookup only — it does not execute the tool and does not
// touch any user's actual Google Calendar. DO NOT GUESS at this shape if it
// ever needs re-verifying; re-run the same metadata lookup.
//
// This file is the ONLY place in the codebase that names this slug or knows
// this response shape (Section 8/9: strict mapper, strict normalizer — no
// other file constructs Composio Calendar arguments or parses its output).
export const GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG = "GOOGLECALENDAR_FIND_FREE_SLOTS";

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
// only ever emits a single calendar id, defaulting to "primary" — TACT's
// own accessible calendar. It has no parameter for an arbitrary email
// address, so this file cannot be used to query a third party's calendar
// even by caller error; that would require a different, not-yet-built,
// explicitly-named attendee-availability entry point (Section 17, not
// implemented in TIME-P1c v1).
export function mapToGoogleCalendarFindFreeSlotsInput(
  request: { readonly rangeStartUtc: string; readonly rangeEndUtc: string; readonly timezone: string },
  calendarId: string
): GoogleCalendarFindFreeSlotsInput {

  return {
    items: [calendarId],
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

// A single malformed busy period fails the entire parse (returns
// undefined) rather than being dropped and continuing — dropping a busy
// period we could not parse would silently make a genuinely busy time look
// free, which this normalizer must never do.
function parseBusyIntervals(value: unknown): BusyInterval[] | undefined {

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed: BusyInterval[] = [];

  for (const entry of value) {

    if (!isRecord(entry) || typeof entry.start !== "string" || typeof entry.end !== "string") {
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

export function normalizeGoogleCalendarFindFreeSlotsOutput(
  rawOutput: unknown,
  calendarId: string
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

  if (!isRecord(rawOutput.data) || !isRecord(rawOutput.data.calendars)) {
    return {
      success: false,
      errorCode: "malformed_response",
      message: "Composio response was missing calendar free/busy data (\"data.calendars\").",
    };
  }

  const calendarWindow = rawOutput.data.calendars[calendarId];

  if (!isRecord(calendarWindow)) {
    // Composio's own tool documentation warns that a calendar omitted from
    // the response, or inaccessible, must never be silently treated as
    // free — this is exactly the "silently produce incorrect availability
    // results" failure mode it warns about, so it is surfaced as an error.
    return {
      success: false,
      errorCode: "permission_denied",
      message: `Calendar "${calendarId}" was not accessible or was not returned by the provider.`,
    };
  }

  if (calendarWindow.is_reliable === false) {
    return {
      success: false,
      errorCode: "permission_denied",
      message: `Calendar "${calendarId}" free/busy data was reported unreliable by the provider.`,
    };
  }

  const busyIntervals = parseBusyIntervals(calendarWindow.busy);

  if (!busyIntervals) {
    return {
      success: false,
      errorCode: "malformed_response",
      message: `Calendar "${calendarId}" busy period data did not match the expected shape.`,
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
