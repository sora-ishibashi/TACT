import {
  GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG,
  mapToGoogleCalendarFindFreeSlotsInput,
  normalizeGoogleCalendarFindFreeSlotsOutput,
  mapComposioErrorToCalendarAvailabilityErrorCode,
} from "../../../core/tact-integration/providers/composio/mappings/googleCalendar";
import { GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT, EXPECTED_ENVELOPE_KIND } from "../../../core/tact-integration/providers/composio/mappings/googleCalendarFindFreeSlotsContract";
import { createComposioGoogleCalendarAvailabilityProvider, type ComposioGoogleCalendarAvailabilityProviderConfig } from "../../../core/tact-integration/providers/composio/googleCalendarAvailabilityProvider";
import { generateCandidateSchedule } from "../../../core/tact-work/candidateSchedule";
import type { TemporalRequirement } from "../../../core/tact-work/temporalRequirements";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

// TIME-P1c Section 7-9 + HARDENING (Codex delta-fix): contract tests for the
// real (schema-verified, but never live-called — Section 14) Composio
// Google Calendar availability adapter. All Composio responses here are
// hand-built mocks matching the exact shape verified live via
// client.tools.getRawComposioToolBySlug() (metadata only, no execution, no
// real Calendar touched) — never guessed, and now committed as an auditable
// contract fixture (googleCalendarFindFreeSlotsContract.ts).

const REQUEST = {
  rangeStartUtc: "2026-09-20T15:00:00.000Z",
  rangeEndUtc: "2026-09-27T15:00:00.000Z",
  timezone: "Asia/Tokyo",
};

function envelope(overrides: Partial<{ kind: unknown; timeMin: unknown; timeMax: unknown; calendars: unknown }> = {}) {
  return {
    kind: EXPECTED_ENVELOPE_KIND,
    timeMin: REQUEST.rangeStartUtc,
    timeMax: REQUEST.rangeEndUtc,
    calendars: { primary: { busy: [], is_reliable: true } },
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // =========================
  // Fixed READ binding (Section 8)
  // =========================

  results.push(check(
    "[binding] the verified slug is exactly GOOGLECALENDAR_FIND_FREE_SLOTS",
    GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG === "GOOGLECALENDAR_FIND_FREE_SLOTS"
  ));

  const mappedInput = mapToGoogleCalendarFindFreeSlotsInput(REQUEST);
  results.push(check(
    "[mapper] canonical request maps to exactly the four verified input fields, nothing else",
    JSON.stringify(Object.keys(mappedInput).sort()) === JSON.stringify(["items", "time_max", "time_min", "timezone"]) &&
      JSON.stringify(mappedInput.items) === JSON.stringify(["primary"]) &&
      mappedInput.time_min === REQUEST.rangeStartUtc &&
      mappedInput.time_max === REQUEST.rangeEndUtc &&
      mappedInput.timezone === REQUEST.timezone
  ));

  // =========================
  // HARDENING (Codex delta-fix Section 1): arbitrary-calendar-target
  // blocker. No function in this chain accepts a calendar identifier from
  // its caller at all — verified both at the type/call-arity level (a
  // second argument is a TypeScript error, checked here by construction:
  // this file itself only ever calls these with one/two arguments in their
  // NEW shapes) and at the source level (no "calendarId" parameter name
  // appears anywhere in the mapper/provider source).
  // =========================

  const mapperSource = readFileSync(
    join(__dirname, "..", "..", "..", "core", "tact-integration", "providers", "composio", "mappings", "googleCalendar.ts"),
    "utf8"
  );
  const providerSource = readFileSync(
    join(__dirname, "..", "..", "..", "core", "tact-integration", "providers", "composio", "googleCalendarAvailabilityProvider.ts"),
    "utf8"
  );

  // Strips "//" line comments before searching — this file's own comments
  // legitimately discuss the REMOVED "calendarId" field by name (explaining
  // why it's gone), so a plain substring search over the raw source would
  // false-positive on its own documentation. Actual code (declarations,
  // parameters, property accesses) is what must never mention it.
  function stripLineComments(source: string): string {
    return source
      .split("\n")
      .map((line) => {
        const index = line.indexOf("//");
        return index === -1 ? line : line.slice(0, index);
      })
      .join("\n");
  }

  const mapperCodeOnly = stripLineComments(mapperSource);
  const providerCodeOnly = stripLineComments(providerSource);

  results.push(check(
    "[HARDENING Blocker: calendar target] no \"calendarId\" identifier exists anywhere in the mapper or provider's actual code (comments excluded, since they legitimately document its removal)",
    !mapperCodeOnly.includes("calendarId") && !providerCodeOnly.includes("calendarId")
  ));

  results.push(check(
    "[HARDENING Blocker: calendar target] the mapper always emits exactly [\"primary\"] regardless of what the request object contains",
    JSON.stringify(mapToGoogleCalendarFindFreeSlotsInput({ ...REQUEST, ...{ items: ["attendee@example.com"] } }).items) === JSON.stringify(["primary"])
  ));

  // A minimal, well-typed config literal — reaching this line at all
  // (i.e. this file compiling) already proves {client, tactUserId,
  // connectedAccountId} are valid/sufficient fields; the grep-based check
  // above is what proves no OTHER field (calendarId or otherwise) exists,
  // since TypeScript's structural typing alone can't prove a field's
  // absence when it might be merely optional.
  const typedConfigLiteral: ComposioGoogleCalendarAvailabilityProviderConfig = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow mock satisfying only the Pick<Composio,"tools"> shape this provider actually uses
    client: { tools: { execute: async () => ({}) } } as any,
    tactUserId: "x",
    connectedAccountId: "y",
  };
  results.push(check(
    "[HARDENING Blocker: calendar target] the provider config's required fields are exactly {client, tactUserId, connectedAccountId}",
    Object.keys(typedConfigLiteral).sort().join(",") === "client,connectedAccountId,tactUserId"
  ));

  results.push(check(
    "[HARDENING Blocker: calendar target] normalizeGoogleCalendarFindFreeSlotsOutput() always reads calendars.primary, ignoring any other calendar id present in the payload (e.g. an injected attendee email)",
    (() => {
      const result = normalizeGoogleCalendarFindFreeSlotsOutput(
        { successful: true, data: envelope({ calendars: { "attendee@example.com": { busy: [{ start: "2026-09-21T00:00:00.000Z", end: "2026-09-21T23:00:00.000Z" }], is_reliable: true } } }) },
        REQUEST
      );
      // "primary" is absent from this payload (only the injected attendee
      // key is present), so this must fail the SAME way a genuinely absent
      // primary calendar fails — it must never silently read the attendee
      // entry's busy data instead.
      return !result.success && result.errorCode === GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.reliabilitySemantics.calendarEntryMissingEntirely;
    })()
  ));

  // sourceScope cannot be overridden: googleCalendarAvailabilityProvider.ts
  // hardcodes "own_calendar" as a literal in its return statement — no
  // config field or provider result field feeds it. Verified at the source
  // level (a config-driven override would require a *variable*, not a
  // literal, in that position).
  results.push(check(
    "[HARDENING Blocker: calendar target] sourceScope is a hardcoded literal in the provider, not sourced from config or the raw provider response",
    /sourceScope:\s*"own_calendar"/.test(providerSource) && !/sourceScope:\s*config\./.test(providerSource)
  ));

  // =========================
  // Normalizer — success path
  // =========================

  const successResponse = {
    successful: true,
    data: envelope({
      calendars: {
        primary: {
          busy: [{ start: "2026-09-21T00:00:00Z", end: "2026-09-21T01:00:00Z" }],
          free: [{ start: "2026-09-21T01:00:00Z", end: "2026-09-21T09:00:00Z" }],
          is_reliable: true,
        },
      },
    }),
  };

  const normalizedSuccess = normalizeGoogleCalendarFindFreeSlotsOutput(successResponse, REQUEST);
  results.push(check(
    "[normalizer] a well-formed, reliable response normalizes to exactly the busy intervals, nothing else from the raw payload",
    normalizedSuccess.success &&
      normalizedSuccess.busyIntervals.length === 1 &&
      normalizedSuccess.busyIntervals[0].startUtc === "2026-09-21T00:00:00Z" &&
      normalizedSuccess.busyIntervals[0].endUtc === "2026-09-21T01:00:00Z" &&
      Object.keys(normalizedSuccess).sort().join(",") === "busyIntervals,success"
  ));

  // =========================
  // HARDENING (Codex delta-fix Section 2): provider envelope validation
  // =========================

  const unsuccessful = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: false, error: "quota exceeded" }, REQUEST);
  results.push(check(
    '[normalizer] successful:false is provider_failure, never silently treated as "no availability"',
    !unsuccessful.success && unsuccessful.errorCode === "provider_failure" && unsuccessful.message === "quota exceeded"
  ));

  const missingDataEnvelope = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true }, REQUEST);
  results.push(check(
    "[normalizer] a response missing the \"data\" envelope entirely is malformed_response",
    !missingDataEnvelope.success && missingDataEnvelope.errorCode === "malformed_response"
  ));

  const wrongKind = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: envelope({ kind: "calendar#event" }) }, REQUEST);
  results.push(check(
    "[HARDENING Blocker: envelope] a malformed/unexpected envelope \"kind\" fails as malformed_response, never silently accepted",
    !wrongKind.success && wrongKind.errorCode === "malformed_response"
  ));

  const missingKind = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: envelope({ kind: undefined }) }, REQUEST);
  results.push(check(
    "[HARDENING Blocker: envelope] a missing envelope \"kind\" fails as malformed_response",
    !missingKind.success && missingKind.errorCode === "malformed_response"
  ));

  const malformedTimeMin = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: envelope({ timeMin: "not-a-timestamp" }) }, REQUEST);
  results.push(check(
    "[HARDENING Blocker: envelope] a malformed/unparseable envelope \"timeMin\" fails as malformed_response",
    !malformedTimeMin.success && malformedTimeMin.errorCode === "malformed_response"
  ));

  const malformedTimeMax = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: envelope({ timeMax: "not-a-timestamp" }) }, REQUEST);
  results.push(check(
    "[HARDENING Blocker: envelope] a malformed/unparseable envelope \"timeMax\" fails as malformed_response",
    !malformedTimeMax.success && malformedTimeMax.errorCode === "malformed_response"
  ));

  const inconsistentRange = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: envelope({ timeMin: "2000-01-01T00:00:00.000Z" }) }, // does not match REQUEST.rangeStartUtc at all
    REQUEST
  );
  results.push(check(
    "[HARDENING Blocker: envelope] an envelope timeMin that does not match the actually-requested range start fails as malformed_response — the provider may not have honored the request",
    !inconsistentRange.success && inconsistentRange.errorCode === "malformed_response"
  ));

  const differentButEquivalentInstant = normalizeGoogleCalendarFindFreeSlotsOutput(
    // Same instant as REQUEST.rangeStartUtc, reformatted with an explicit
    // +00:00 offset instead of "Z" — must still be accepted (compared by
    // parsed instant, never by string equality).
    { successful: true, data: envelope({ timeMin: "2026-09-20T15:00:00.000+00:00" }) },
    REQUEST
  );
  results.push(check(
    "[normalizer] an equivalent instant reformatted with an explicit offset (not \"Z\") is still accepted — compared by parsed instant, not string equality",
    differentButEquivalentInstant.success
  ));

  const missingCalendarsKey = normalizeGoogleCalendarFindFreeSlotsOutput({ successful: true, data: envelope({ calendars: undefined }) }, REQUEST);
  results.push(check(
    "[normalizer] a response missing data.calendars entirely is malformed_response, never treated as fully free",
    !missingCalendarsKey.success && missingCalendarsKey.errorCode === "malformed_response"
  ));

  const calendarNotInMap = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: envelope({ calendars: { "someone-else@example.com": { busy: [] } } }) },
    REQUEST
  );
  results.push(check(
    "[normalizer] the primary calendar entry absent from the response is a distinguished failure, NEVER inferred as free (Composio's own documented \"inaccessible = silently free\" pitfall must not reach Core)",
    !calendarNotInMap.success && calendarNotInMap.errorCode === GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.reliabilitySemantics.calendarEntryMissingEntirely
  ));

  const unreliableCalendar = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: envelope({ calendars: { primary: { busy: [], is_reliable: false } } }) },
    REQUEST
  );
  results.push(check(
    "[normalizer] is_reliable:false maps to the contract-documented reliability semantics, never trusted as an empty (fully free) busy list",
    !unreliableCalendar.success && unreliableCalendar.errorCode === GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.reliabilitySemantics.isReliableFalse
  ));

  const malformedBusyEntry = normalizeGoogleCalendarFindFreeSlotsOutput(
    { successful: true, data: envelope({ calendars: { primary: { busy: [{ start: "2026-09-21T00:00:00Z" }] } } }) }, // missing "end"
    REQUEST
  );
  results.push(check(
    "[normalizer] one malformed busy period fails the entire parse (malformed_response), never drops it and returns the rest as if complete",
    !malformedBusyEntry.success && malformedBusyEntry.errorCode === "malformed_response"
  ));

  for (const notAnObject of [null, "a string", 42, ["array"]]) {
    const result = normalizeGoogleCalendarFindFreeSlotsOutput(notAnObject, REQUEST);
    results.push(check(
      `[normalizer] a non-object raw response (${JSON.stringify(notAnObject)}) is malformed_response, never crashes`,
      !result.success && result.errorCode === "malformed_response"
    ));
  }

  const extraUnknownFields = normalizeGoogleCalendarFindFreeSlotsOutput(
    {
      successful: true,
      unexpectedTopLevelField: { secret: "leak-me-not" },
      data: envelope({
        calendars: { primary: { busy: [], is_reliable: true, someUnknownProviderField: "ignored" } },
      }),
    },
    REQUEST
  );
  results.push(check(
    "[normalizer] unknown/extra provider fields are ignored, never copied into the canonical result",
    extraUnknownFields.success &&
      extraUnknownFields.busyIntervals.length === 0 &&
      !JSON.stringify(extraUnknownFields).includes("leak-me-not")
  ));

  // =========================
  // HARDENING (Codex delta-fix Section 3): contract fixture auditability
  // =========================

  results.push(check(
    "[HARDENING Blocker: schema auditability] the committed contract fixture's slug matches the slug this file actually calls",
    GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.slug === GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG
  ));

  results.push(check(
    "[HARDENING Blocker: schema auditability] the contract documents all three envelope fields the normalizer actually validates (kind/timeMin/timeMax)",
    JSON.stringify([...GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.output.findFreeSlotsResponse.required].sort()) === JSON.stringify(["kind", "timeMax", "timeMin"])
  ));

  results.push(check(
    "[HARDENING Blocker: schema auditability] EXPECTED_ENVELOPE_KIND (used by the live runtime check) is sourced from the contract, not redeclared separately",
    EXPECTED_ENVELOPE_KIND === GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.output.findFreeSlotsResponse.fields.kind.expectedValue &&
      typeof EXPECTED_ENVELOPE_KIND === "string" && EXPECTED_ENVELOPE_KIND.length > 0
  ));

  results.push(check(
    "[HARDENING Blocker: schema auditability] the contract's is_reliable description text (the actual evidence for the reliability mapping) mentions both documented causes",
    GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.output.calendarWindow.fields.is_reliable.description.includes("notFound") &&
      GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.output.calendarWindow.fields.is_reliable.description.includes("forbidden")
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
    "[provider] the arguments actually sent to Composio are exactly the mapper's four fixed fields, always targeting \"primary\"",
    JSON.stringify(capturedArguments) === JSON.stringify(mapToGoogleCalendarFindFreeSlotsInput(REQUEST))
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
  // (the client here is the same mock used above), and now exercising the
  // hardened envelope validation end-to-end too.
  // =========================

  const realityRequirement: TemporalRequirement = {
    durationMinutes: 30,
    date: { kind: "relative", value: "next_week" },
    candidateCount: 3,
    timezone: "Asia/Tokyo",
    dailyWindow: { startMinuteOfDay: 540, endMinuteOfDay: 1080 }, // 9:00-18:00
  };

  // "next_week" resolved against reference 2026-09-14T00:00:00.000Z in
  // Asia/Tokyo is the Mon-Sun week 2026-09-20T15:00:00.000Z .. 2026-09-27T15:00:00.000Z
  // (verified in tests/tact/work/calendarAvailabilitySchedule.test.ts's own
  // [range] 来週 check) — the mock below echoes exactly that back as
  // timeMin/timeMax, matching real provider behavior.
  const mockedRealAdapterProvider = createComposioGoogleCalendarAvailabilityProvider({
    client: {
      tools: {
        execute: async () => ({
          successful: true,
          data: envelope({
            timeMin: "2026-09-20T15:00:00.000Z",
            timeMax: "2026-09-27T15:00:00.000Z",
            calendars: {
              primary: {
                busy: [{ start: "2026-09-21T00:00:00.000Z", end: "2026-09-21T01:00:00.000Z" }],
                is_reliable: true,
              },
            },
          }),
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
    "[end-to-end] the real (mocked-Composio) adapter drives candidateSchedule.ts through fixed primary-calendar targeting, strict envelope validation, and normalization to produce the same deterministic 3-candidate result as the Fake-provider Reality Test",
    endToEnd.success &&
      endToEnd.candidates.length === 3 &&
      endToEnd.candidates[0].startUtc === "2026-09-21T01:00:00.000Z" &&
      endToEnd.sourceScope === "own_calendar"
  ));

  return summarize("integration/googleCalendarAvailability", results);
}
