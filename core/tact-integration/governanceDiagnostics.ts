// =========================
// Root Yolna — Runs Governance Diagnostics (SOR-138 Slice 3A-4)
// =========================
//
// Diagnostics-only instrumentation. This module changes NOTHING about
// execution.ts's control flow, the Preflight wire contract, Run lifecycle,
// post-ALLOW revalidation, or Principal identity semantics — every call
// site in execution.ts only ever calls emitGovernanceDiagnosticEvent() as
// an additional, side-effect-only observation around an existing step. No
// existing return value, branch, or timing-sensitive behavior changes
// because this module exists (see execution.ts's own call sites).
//
// Motivation (SOR-138 Slice 3A-4 read-only root-cause investigation,
// 2026-10-08): a Reality Test produced a persisted Runs GovernanceDecision
// (verdict=ALLOW) with zero root-side Run created and zero provider call,
// and that investigation could not determine WHERE the divergence
// happened — transport (timeout/network/shape), post-ALLOW revalidation,
// or the createRun() boundary — because neither side had emitted any
// timestamped evidence. This module exists only to produce that evidence
// for the NEXT Reality Test attempt; it is not itself a fix, and does not
// change whether that divergence can still occur.
//
// Absolute condition (do not relax): emitGovernanceDiagnosticEvent() is a
// no-op unless RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED==="true" exactly (same
// disabled-by-default, exact-string-match pattern as
// RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED) — never emitted
// unconditionally, never on by default, never in Production without an
// explicit operator opt-in. Every event below is a hand-typed, closed
// union of primitive fields (string enum / number / boolean / null) only.
// There is no raw object, header, body, HMAC material, credential, or
// error passthrough anywhere in this file — a caller cannot accidentally
// leak a secret through this module because the type system never gives
// it a slot to put one in. Do not add a field that is not an
// enum/primitive without re-reading this header comment first.
//
// invocationId is the one correlation identifier this module does log —
// per the owning instructions, that is acceptable only because it is
// gated behind the same disabled-by-default env flag as everything else
// here (i.e. only recorded in a deliberately-enabled diagnostic
// environment, never unconditionally).

import type { PreflightVerdict } from "@tact/execution-contract";
import type { GovernanceClientUnavailableReason } from "./runsGovernance";

export function isGovernanceDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED === "true";
}

export type GovernanceDiagnosticEvent =
  | {
      stage: "preflight_request_started";
      invocationId: string;
      service: string;
      operation: string;
      actionCategory: string;
    }
  | {
      stage: "preflight_transport_completed";
      invocationId: string;
      durationMs: number;
      httpStatus: number | null;
      transportResult: "decided" | GovernanceClientUnavailableReason;
    }
  | {
      stage: "root_decision_gate";
      invocationId: string;
      outcome: "accepted" | "rejected";
      rejectionCategory: string | null;
      verdict: PreflightVerdict | null;
    }
  | {
      stage: "revalidation_entered";
      invocationId: string;
      plannedAttempt: number;
    }
  | {
      stage: "revalidation_resolved";
      invocationId: string;
      outcome: "passed" | "rejected";
      rejectionCategory: string | null;
      plannedAttempt: number;
      observedAttempt: number | null;
      attemptMatch: boolean | null;
    }
  | {
      stage: "run_creation_entered";
      invocationId: string;
    }
  | {
      stage: "run_creation_resolved";
      invocationId: string;
      outcome: "succeeded" | "failed";
      errorCategory: string | null;
    };

export interface GovernanceDiagnosticsDeps {
  env?: NodeJS.ProcessEnv;
  emit?: (line: string) => void;
}

const DIAGNOSTIC_LOG_TAG = "[runs-governance-diagnostics]";

export function emitGovernanceDiagnosticEvent(
  event: GovernanceDiagnosticEvent,
  deps: GovernanceDiagnosticsDeps = {}
): void {

  const env = deps.env ?? process.env;
  if (!isGovernanceDiagnosticsEnabled(env)) {
    return;
  }

  const emit = deps.emit ?? ((line: string) => console.warn(line));

  emit(`${DIAGNOSTIC_LOG_TAG} ${JSON.stringify(event)}`);

}
