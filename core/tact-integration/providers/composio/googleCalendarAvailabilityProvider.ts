import type { Composio } from "@composio/core";
import type {
  CalendarAvailabilityProvider,
  CalendarAvailabilityProviderResult,
  CalendarAvailabilityRequest,
} from "../../../tact-work/calendarAvailability";
import { normalizeBusyIntervals } from "../../../tact-work/calendarAvailability";
import { getGoogleCalendarToolkitVersion, toComposioUserId } from "./client";
import {
  GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG,
  mapToGoogleCalendarFindFreeSlotsInput,
  normalizeGoogleCalendarFindFreeSlotsOutput,
  mapComposioErrorToCalendarAvailabilityErrorCode,
} from "./mappings/googleCalendar";

// =========================
// TACT Integration — real Composio Google Calendar availability provider
// (TIME-P1c Section 7-9)
// =========================
//
// Deliberately NOT wired into core/tact-integration/execution.ts's generic
// IntegrationProvider/executeComposio() dispatch, the Capability Registry,
// or core/tact-conversation/orchestration.ts (TIME-P1c Section 13: partial
// production wiring is not allowed — Calendar connection representation
// [core/tact-integration/types.ts's IntegrationService, provisioning,
// policy] does not exist yet, see the phase report's connection-model audit
// finding). This file exists so a real, schema-verified
// CalendarAvailabilityProvider is available to call directly wherever a
// caller already has a Composio-connected Google Calendar account
// identifier — the same role the Fake provider
// (core/tact-work/calendarAvailability.ts) plays for tests, just backed by
// a real (but never yet actually invoked — Section 14) Composio call.
//
// Hard read-only enforcement (Section 8), structurally, not just by
// convention:
//   - GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG is the only slug this file
//     references, as a literal constant imported from
//     ./mappings/googleCalendar.ts — never a variable built from caller
//     input, LLM output, or a lookup table keyed by anything the caller
//     controls.
//   - CalendarAvailabilityProvider (core/tact-work/calendarAvailability.ts)
//     declares exactly one method, getAvailability() — there is no way to
//     reach a write/insert/update/delete/invite/RSVP operation through this
//     object even if a caller wanted to; no such method exists on it.
//   - The Composio arguments object is built exclusively by
//     mapToGoogleCalendarFindFreeSlotsInput(), which emits exactly four
//     fixed keys (items/time_min/time_max/timezone) — no caller-supplied
//     object is ever spread or merged into it.

export interface ComposioGoogleCalendarAvailabilityProviderConfig {
  readonly client: Pick<Composio, "tools">;
  // TACT userId (not the Composio-namespaced id — toComposioUserId()
  // derives that here, same as adapter.ts does for Slack/Gmail/Notion).
  readonly tactUserId: string;
  // Resolved Composio connected-account reference for this user's Google
  // Calendar connection. Resolving this from a real tact_connections row is
  // explicitly out of scope this phase (Section 6/13) — the caller
  // supplies it directly.
  readonly connectedAccountId: string;
  // Defaults to "primary" (the authenticated user's own calendar).
  // Section 10/16/17 (attendee honesty, enforced structurally): there is no
  // supported way to pass another person's email address as a target
  // through this config — set this only to one of the connected user's own
  // calendar ids.
  readonly calendarId?: string;
}

const DEFAULT_CALENDAR_ID = "primary";

export function createComposioGoogleCalendarAvailabilityProvider(
  config: ComposioGoogleCalendarAvailabilityProviderConfig
): CalendarAvailabilityProvider {

  const calendarId = config.calendarId ?? DEFAULT_CALENDAR_ID;
  const toolkitVersion = getGoogleCalendarToolkitVersion();

  return {

    async getAvailability(request: CalendarAvailabilityRequest): Promise<CalendarAvailabilityProviderResult> {

      let rawOutput: unknown;

      try {

        rawOutput = await config.client.tools.execute(GOOGLECALENDAR_FIND_FREE_SLOTS_SLUG, {
          userId: toComposioUserId(config.tactUserId),
          connectedAccountId: config.connectedAccountId,
          arguments: mapToGoogleCalendarFindFreeSlotsInput(request, calendarId),
          version: toolkitVersion,
          dangerouslySkipVersionCheck: toolkitVersion === "latest",
        });

      } catch (error) {

        const mapped = mapComposioErrorToCalendarAvailabilityErrorCode(error);
        return { success: false, error: { code: mapped.code, message: mapped.message } };

      }

      const normalized = normalizeGoogleCalendarFindFreeSlotsOutput(rawOutput, calendarId);

      if (!normalized.success) {
        return { success: false, error: { code: normalized.errorCode, message: normalized.message } };
      }

      return {
        success: true,
        result: {
          rangeStartUtc: request.rangeStartUtc,
          rangeEndUtc: request.rangeEndUtc,
          timezone: request.timezone,
          busyIntervals: normalizeBusyIntervals(normalized.busyIntervals, request.rangeStartUtc, request.rangeEndUtc),
          sourceScope: "own_calendar",
        },
      };

    },

  };

}
