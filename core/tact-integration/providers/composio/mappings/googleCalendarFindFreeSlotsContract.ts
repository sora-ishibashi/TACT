// =========================
// TACT Integration — Composio GOOGLECALENDAR_FIND_FREE_SLOTS contract
// (TIME-P1c HARDENING, Codex delta-fix Section 3: schema auditability)
// =========================
//
// Codex could not independently audit the schema verification claimed in
// ./googleCalendar.ts's comments, because the repository contained only
// prose describing a live lookup nobody else could re-run without their
// own COMPOSIO_API_KEY. This file is that lookup's result, committed as a
// sanitized, typed, version-controlled record — so a reviewer (human or
// Codex) can check the mapper/normalizer against a concrete artifact
// instead of trusting a comment.
//
// Provenance: retrieved via Composio's tool metadata endpoint
// (`client.tools.getRawComposioToolBySlug("GOOGLECALENDAR_FIND_FREE_SLOTS")`)
// — a schema/metadata lookup only. It does NOT execute the tool and does
// NOT touch any user's actual Google Calendar; no connected account is
// involved in retrieving a tool's schema. Re-verify by re-running that same
// call if this ever needs updating — do not guess at a replacement.
//
// Contains ONLY: the action slug, toolkit/version identifiers, and
// input/output field names, types, and Composio's own field descriptions.
// Contains NONE of: credentials, tokens, connected-account identifiers, or
// any real Calendar data — none of those were ever part of this lookup's
// result in the first place (a schema is not user data).
//
// mappings/googleCalendar.ts imports the two values below directly
// (EXPECTED_ENVELOPE_KIND, RELIABILITY_SEMANTICS) rather than duplicating
// them — so this fixture and the actual runtime validation cannot silently
// drift apart from each other.

export const GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT = {

  slug: "GOOGLECALENDAR_FIND_FREE_SLOTS",
  toolkitSlug: "googlecalendar",
  verifiedAtToolkitVersion: "20260902_00",
  verifiedOnUtc: "2026-09-14",

  // ---- Input (verified: FindFreeSlotsRequest) ----
  // Every field is schema-optional (each has a documented default), but
  // TACT's mapper always supplies time_min/time_max/timezone explicitly
  // regardless — Composio's own documented default for an omitted
  // time_min/time_max is "the current timestamp", which is exactly the
  // implicit-now dependency TIME-P1c's own range resolution exists to
  // eliminate (core/tact-work/temporalRange.ts).
  input: {
    fields: {
      items: {
        type: "array<string>",
        default: ["primary"],
        description: "List of calendar identifiers to query. TACT always supplies exactly [\"primary\"] — never caller-controlled (Section 1 delta-fix).",
      },
      time_min: { type: "string (ISO 8601 or comma-separated/simple datetime)", required: false, description: "Start datetime for the query interval; inclusive." },
      time_max: { type: "string (ISO 8601 or comma-separated/simple datetime)", required: false, description: "End datetime for the query interval; exclusive." },
      timezone: { type: "string (IANA identifier)", default: "UTC", description: "Determines how naive time_min/time_max are interpreted and the timezone used in the response." },
      group_expansion_max: { type: "integer", default: 100, min: 1, max: 100 },
      calendar_expansion_max: { type: "integer", default: 50, min: 1, max: 50 },
    },
  },

  // ---- Output (verified: FindFreeSlotsResponseWrapper / FindFreeSlotsResponse / CalendarWindow) ----
  output: {

    envelope: {
      required: ["data", "successful"] as const,
      fields: {
        successful: { type: "boolean", description: "Whether or not the action execution was successful." },
        error: { type: "string", required: false, description: "Error if any occurred during execution." },
        data: { type: "FindFreeSlotsResponse (see findFreeSlotsResponse below)" },
      },
    },

    findFreeSlotsResponse: {
      required: ["kind", "timeMin", "timeMax"] as const,
      fields: {
        kind: { type: "string", expectedValue: "calendar#freeBusy", description: "Resource type identifier. Always 'calendar#freeBusy' for free/busy queries." },
        timeMin: { type: "string (ISO 8601)", description: "Inclusive start of the query window." },
        timeMax: { type: "string (ISO 8601)", description: "Exclusive end of the query window." },
        calendars: {
          type: "object (map: calendar id -> CalendarWindow)",
          required: false,
          description: "Optional to accommodate observed responses where this key may be absent.",
        },
      },
    },

    calendarWindow: {
      fields: {
        busy: { type: "array<{ start: string, end: string }>", description: "Busy time ranges within [timeMin, timeMax]." },
        free: { type: "array<{ start: string, end: string }>", description: "Computed free time ranges. Not used by TACT's normalizer — busy is the sole source of truth for canonical BusyInterval[]." },
        is_reliable: {
          type: "boolean | undefined",
          description: "Indicates whether the free/busy data for this calendar is reliable. Set to False when the calendar query encountered errors (e.g., notFound, forbidden), meaning the free/busy information may be incomplete or inaccurate. When False, the 'free' field will be empty even if no busy periods exist. Omitted (None) when no errors were encountered, indicating the data is reliable.",
        },
      },
    },

  },

  // ---- Reliability / error-semantics decision (Section 6 delta-fix) ----
  // Grounded directly in the is_reliable description above, not a guess:
  // the schema's own documented causes are "notFound, forbidden" — both
  // access-related — so is_reliable:false on the ONE calendar TACT ever
  // queries ("primary", the connected account's own calendar) maps to
  // permission_denied. It must never mean "no availability" (that would
  // falsely assert a confirmed, empty candidate result from data the
  // provider itself flagged as unreliable).
  //
  // A calendars["primary"] entry that is entirely ABSENT (rather than
  // present-but-unreliable) is a structurally different signal — not the
  // documented is_reliable mechanism at all — so it is kept distinct as
  // malformed_response rather than assumed to share the same cause.
  reliabilitySemantics: {
    isReliableFalse: "permission_denied",
    calendarEntryMissingEntirely: "malformed_response",
  },

} as const;

// Re-exported directly from the contract object above (never redeclared as
// a separate literal) so the actual runtime check in ./googleCalendar.ts
// and this documented contract cannot silently drift apart.
export const EXPECTED_ENVELOPE_KIND = GOOGLE_CALENDAR_FIND_FREE_SLOTS_CONTRACT.output.findFreeSlotsResponse.fields.kind.expectedValue;
