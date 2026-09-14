import {
  GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG,
  mapToGoogleCalendarFindFreeSlotsInput,
  normalizeGoogleCalendarFindFreeSlotsOutput,
  mapComposioErrorToCalendarAvailabilityErrorCode,
} from "../../../core/tact-integration/providers/composio/mappings/googleCalendar";
import { createComposioGoogleCalendarAvailabilityProvider } from "../../../core/tact-integration/providers/composio/googleCalendarAvailabilityProvider";
import { generateCandidateSchedule } from "../../../core/tact-work/candidateSchedule";
import type { TemporalRequirement } from "../../../core/tact-work/temporalRequirements";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c Section 7-9: contract tests for the real (schema-verified, but
// never live-called — Section 14) Composio Google Calendar availability
// adapter. All Composio responses here are hand-built mocks matching the
// exact shape verified live via client.tools.getRawComposioToolBySlug()
// (metadata only, no execution, no real Calendar touched) — never guessed.

const REQUEST = {
  rangeStartUtc: "2026-09-20T15:00:00.000Z",
  rangeEndUtc: "2026-09-27T15:00:00.000Z",
  timezone: "Asia/Tokyo",
};

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // Fixed READ binding (Section 8)
  // =========================

  results.push(check(
    "[binding] the verified slug is exactly GOOGLECALENDAR_FIND_FREE_SLOTS",
    GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG === "GOOGLECALENDAR_FIND_FREE_SLOTS"
  ));

  const mappedInput = mapToGoogleCalendarFindFreeSlotsInput(REQUEST, "primary");
  results.push(check(
    "[mapper] canonical request maps to exactly the four verified input fields, nothing else",
    JSON.stringify(Object.keys(mappedInput).sort()) === JSON.stringify(["items", "time_max", "time_min", "timezone"]) &&
      JSON.stringify(mappedInput.items) === JSON.stringify(["primary"]) &&
      mappedInput.time_min === REQUEST.rangeStartUtc &&
      mappedInput.time_max === REQUEST.rangeEndUtc &&
      mappedInput.timezone === REQUEST.timezone
  ));

  // =========================
  // Normalizer — success path
  // =========================

  const successResponse = {
    successful: true,
    data: {
      kind: "calendar#freeBusy",
      timeMin: REQUEST.rangeStartUtc,
      timeMax: REQUEST.rangeEndUtc,
      calendars: {
        primary: {
          busy: [{ start: "2026-09-21T00:00:00Z", end: "2026-09-21T01:00:00Z" }],
          free: [{ start: "2026-09-21T01:00:00Z", end: "2026-09-21T09:00:00Z" }],
          is_reliable: true,
        },
      },
    },
  };

  const normalizedSuccess = normalizeGoogleCalendarFindFreeSlotsOutput(successResponse, "primary");
  results.push(check(
    "[normalizer] a well-formed, reliable response normalizes to exactly the busy intervals, nothing else from the raw payload",
    normalizedSuccess.success &&
      normalizedSuccess.busyIntervals.length === 1 &&
      normalizedSuccess.busyIntervals[0].startUtc === "2026-09-21T00:00:00Z" &&
      normalizedSuccess.busyIntervals[0].endUtc === "2026-09-21T01:00:00Z" &&
      Object.keys(normalizedSuccess).sort().join(",") === "busyIntervals,success"
  ));

  // =========================
  // Normalizer — error taxonomy (Section 9/12)
  // =========================

  const unsuccessful = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: false, error: "quota exceeded" }, "primary");
  results.push(check(
    '[normalizer] successful:false is provider_failure, never silently treated as "no availability"',
    !unsuccessful.success && unsuccessful.errorCode === "provider_failure" && unsuccessful.message === "quota exceeded"
  ));

  const missingCalendarsKey = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: { kind: "calendar#freeBusy" } }, "primary");
  results.push(check(
    "[normalizer] a response missing data.calendars entirely is malformed_response, never treated as fully free",
    !missingCalendarsKey.success && missingCalendarsKey.errorCode === "malformed_response"
  ));

  const calendarNotInMap = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: { calendars: { "someone-else@example.com": { busy: [] } } } },
    "primary"
  );
  results.push(check(
    '[normalizer] the requested calendar id absent from the response is permission_denied, NEVER inferred as free (Composio\'s own documented "inaccessible = silently free" pitfall must not reach Core)',
    !calendarNotInMap.success && calendarNotInMap.errorCode === "permission_denied"
  ));

  const unreliableCalendar = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: { calendars: { primary: { busy: [], is_reliable: false } } } },
    "primary"
  );
  results.push(check(
    "[normalizer] is_reliable:false is permission_denied, never trusted as an empty (fully free) busy list",
    !unreliableCalendar.success && unreliableCalendar.errorCode === "permission_denied"
  ));

  const malformedBusyEntry = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: { calendars: { primary: { busy: [{ start: "2026-09-21T00:00:00Z" }] } } } }, // missing "end"
    "primary"
  );
  results.push(check(
    "[normalizer] one malformed busy period fails the entire parse (malformed_response), never drops it and returns the rest as if complete",
    !malformedBusyEntry.success && malformedBusyEntry.errorCode === "malformed_response"
  ));

  for (const notAnObject of [null, "a string", 42, ["array"]]) {
    const result = normalizeGoogleCalendarFindFreeSlotsOutput(notAnObject, "primary");
    results.push(check(
      `[normalizer] a non-object raw response (${JSON.stringify(notAnObject)}) is malformed_response, never crashes`,
      !result.success && result.errorCode === "malformed_response"
    ));
  }

  const extraUnknownFields = normalizeGoogleCalendarFindFreeSlotsOutput(
    {
      successful: true,
      unexpectedTopLevelField: { secret: "leak-me-not" },
      data: {
        calendars: { primary: { busy: [], is_reliable: true, someUnknownProviderField: "ignored" } },
        display_url: "https://calendar.google.com/should-not-leak",
      },
    },
    "primary"
  );
  results.push(check(
    "[normalizer] unknown/extra provider fields are ignored, never copied into the canonical result",
    extraUnknownFields.success &&
      extraUnknownFields.busyIntervals.length === 0 &&
      !JSON.stringify(extraUnknownFields).includes("leak-me-not") &&
      !JSON.stringify(extraUnknownFields).includes("should-not-leak")
  ));

  // =========================
  // Composio SDK error -> CalendarAvailabilityErrorCode
  // =========================

  results.push(check(
    "[error-mapping] an unrecognized/generic thrown error still maps to a valid, distinct error code (provider_failure), never crashes the caller",
    mapComposioErrorToCalendarAvailabilityErrorCode(new Error("boom")).code === "provider_failure"
  ));

  // =========================
  // Provider factory — hard read-only enforcement (Section 8), verified via
  // a mocked Composio client (no live call).
  // =========================

  let capturedSlug: string | undefined;
  let capturedArguments: unknown;

  const fakeComposioClient = {
    tools: {
      execute: async (slug: string, params: { arguments: unknown }) => {
        capturedSlug = slug;
        capturedArguments = params.arguments;
        return successResponse;
      },
    },
  };

  const provider = createComposioGoogleCalendarAvailabilityProvider({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow mock satisfying only the Pick<Composio,"tools"> shape this provider actually uses
    client: fakeComposioClient as any,
    tactUserId: "user-1",
    connectedAccountId: "conn-abc",
  });

  const providerResult = await provider.getAvailability(REQUEST);

  results.push(check(
    "[provider] getAvailability() calls tools.execute() with exactly the fixed verified slug, never a caller/config-derived one",
    capturedSlug === "GOOGLECALENDAR_FIND_FREE_SLOTS"
  ));

  results.push(check(
    "[provider] the arguments actually sent to Composio are exactly the mapper's four fixed fields",
    JSON.stringify(capturedArguments) === JSON.stringify(mapToGoogleCalendarFindFreeSlotsInput(REQUEST, "primary"))
  ));

  results.push(check(
    "[provider] a successful mocked call produces a canonical AvailabilityResult with sourceScope \"own_calendar\" and no raw provider fields",
    providerResult.success &&
      providerResult.result.sourceScope === "own_calendar" &&
      providerResult.result.busyIntervals.length === 1 &&
      !("kind" in providerResult.result) &&
      !("display_url" in providerResult.result)
  ));

  // A thrown SDK-style error still yields a valid, distinct, canonical error
  // — not a crash, not a silent "no availability".
  const throwingClient = {
    tools: {
      execute: async () => {
        throw new Error("connected account not found");
      },
    },
  };
  const throwingProvider = createComposioGoogleCalendarAvailabilityProvider({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow mock satisfying only the Pick<Composio,"tools"> shape this provider actually uses
    client: throwingClient as any,
    tactUserId: "user-1",
    connectedAccountId: "conn-missing",
  });
  const throwingResult = await throwingProvider.getAvailability(REQUEST);
  results.push(check(
    "[provider] a thrown Composio error is mapped to a canonical error, never an uncaught exception or a silent empty result",
    !throwingResult.success && typeof throwingResult.error.code === "string"
  ));

  // =========================
  // Source-level structural safety (Section 8): grep-based, same technique
  // used elsewhere in this suite (e.g. tests/tact/work/temporalRequirements.test.ts).
  // =========================

  const mapperSource = readFileSync(
    join(__dirname, "..", "..", "..", "core", "tact-integration", "providers", "composio", "mappings", "googleCalendar.ts"),
    "utf8"
  );
  const providerSource = readFileSync(
    join(__dirname, "..", "..", "..", "core", "tact-integration", "providers", "composio", "googleCalendarAvailabilityProvider.ts"),
    "utf8"
  );

  const otherCalendarSlugPattern = /GOOGLECALENDAR_(?!FIND_FREE_SLOTS)[A-Z_]+/;
  results.push(check(
    "[safety] no other googlecalendar action slug (create/update/delete/move/invite/RSVP or otherwise) is named anywhere in the mapper or provider files",
    !otherCalendarSlugPattern.test(mapperSource) && !otherCalendarSlugPattern.test(providerSource)
  ));

  results.push(check(
    "[safety] tools.execute() is called with the imported slug CONSTANT, not a variable built from the request/config",
    /tools\.execute\(\s*GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG\s*,/.test(providerSource)
  ));

  // =========================
  // End-to-end: the real adapter plugs into the exact same
  // core/tact-work/candidateSchedule.ts pipeline as the Fake provider does
  // in the Foundation's Reality Test — proving CalendarAvailabilityProvider
  // is genuinely provider-neutral, still with zero live Composio calls
  // (the client here is the same mock used above).
  // =========================

  const realityRequirement: TemporalRequirement = {
    durationMinutes: 30,
    date: { kind: "relative", value: "next_week" },
    candidateCount: 3,
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 540, endMinuteOfDay: 1080 }, // 9:00-18:00
  };

  const mockedRealAdapterProvider = createComposioGoogleCalendarAvailabilityProvider({
    client: {
      tools: {
        execute: async () => ({
          successful: true,
          data: {
            calendars: {
              primary: {
                busy: [{ start: "2026-09-21T00:00:00.000Z", end: "2026-09-21T01:00:00.000Z" }],
                is_reliable: true,
              },
            },
          },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow mock satisfying only the Pick<Composio,"tools"> shape this provider actually uses
    } as any,
    tactUserId: "user-1",
    connectedAccountId: "conn-abc",
  });

  const endToEnd = await generateCandidateSchedule({
    requirement: realityRequirement,
    referenceInstantUtc: "2026-09-14T00:00:00.000Z",
    provider: mockedRealAdapterProvider,
  });

  results.push(check(
    "[end-to-end] the real (mocked-Composio) adapter drives candidateSchedule.ts to produce the same deterministic 3-candidate result as the Fake-provider Reality Test",
    endToEnd.success &&
      endToEnd.candidates.length === 3 &&
      endToEnd.candidates[0].startUtc === "2026-09-21T01:00:00.000Z" &&
      endToEnd.sourceScope === "own_calendar"
  ));

  return summarize("integration/googleCalendarAvailability", results);
}
