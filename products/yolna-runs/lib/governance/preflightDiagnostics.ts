// =========================
// Standalone Runs — Governance Preflight Diagnostics (SOR-138 Slice 3A-4)
// =========================
//
// Diagnostics-only instrumentation. This module changes NOTHING about the
// Preflight route's control flow, HTTP mapping, HMAC verification,
// Principal resolution, or Core decision semantics — see
// app/api/tact/runs/governance/preflight/route.ts's own call sites, which
// only ever call emitGovernancePreflightDiagnosticEvent() as an additional,
// side-effect-only observation after each existing step. No existing
// return value, status code, or timing-sensitive behavior changes because
// this module exists.
//
// Motivation (SOR-138 Slice 3A-4 read-only root-cause investigation,
// 2026-10-08): that investigation could not distinguish "the route
// returned a correct 200 ALLOW and the root client's transport converted
// it to unavailable" from "the route itself diverged before constructing
// that response", because no timestamped evidence existed on either side.
// This module exists only to produce that evidence for the NEXT Reality
// Test attempt — it is not itself a fix and does not change whether that
// divergence can occur.
//
// Absolute condition (do not relax): emitGovernancePreflightDiagnosticEvent()
// is a no-op unless RUNS_GOVERNANCE_PREFLIGHT_DIAGNOSTICS_ENABLED==="true"
// exactly (same disabled-by-default, exact-string-match pattern as
// RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED on the root side) — this is
// never emitted unconditionally in Production. Every event below is a
// hand-typed, closed union of primitive fields (string enum / number /
// boolean / null) only. There is no raw object, header, body, provider
// payload, or error passthrough anywhere in this file — a caller cannot
// accidentally leak a secret through this module because the type system
// never gives it a slot to put one in. Do not add a field that is not an
// enum/primitive without re-reading this header comment first.
//
// "response_construction_reached" proves only that this route is about to
// return a NextResponse object with the stated HTTP status — it does NOT
// prove the HTTP client on the other end ever received or parsed that
// response. Do not rename this event or read it as proof of delivery.

export function isGovernancePreflightDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.RUNS_GOVERNANCE_PREFLIGHT_DIAGNOSTICS_ENABLED === "true";
}

export type GovernancePreflightDiagnosticEvent =
  | {
      stage: "request_reached";
      invocationId: null;
      elapsedMs: number;
    }
  | {
      stage: "principal_resolved";
      invocationId: string | null;
      outcome: "resolved" | "created" | "invalid" | "unavailable";
      elapsedMs: number;
    }
  | {
      stage: "core_decision_returned";
      invocationId: string | null;
      outcome: "decided" | "invalid" | "invocation_conflict" | "unavailable";
      verdict: "ALLOW" | "DENY" | "APPROVAL_REQUIRED" | "UNKNOWN" | null;
      elapsedMs: number;
    }
  | {
      stage: "response_construction_reached";
      invocationId: string | null;
      httpStatusToSend: number;
      elapsedMs: number;
    };

export interface GovernancePreflightDiagnosticsDeps {
  env?: NodeJS.ProcessEnv;
  emit?: (line: string) => void;
}

const DIAGNOSTIC_LOG_TAG = "[runs-governance-preflight-diagnostics]";

export function emitGovernancePreflightDiagnosticEvent(
  event: GovernancePreflightDiagnosticEvent,
  deps: GovernancePreflightDiagnosticsDeps = {}
): void {

  const env = deps.env ?? process.env;
  if (!isGovernancePreflightDiagnosticsEnabled(env)) {
    return;
  }

  const emit = deps.emit ?? ((line: string) => console.warn(line));

  emit(`${DIAGNOSTIC_LOG_TAG} ${JSON.stringify(event)}`);

}
