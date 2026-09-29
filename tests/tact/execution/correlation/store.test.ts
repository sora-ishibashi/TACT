// =========================
// TACT Canonical Execution — Transactional Work Correlation RPC contract
// =========================
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  persistWorkCorrelationDecision,
  type PersistWorkCorrelationDecisionDeps,
} from "../../../../core/tact-execution/correlation/store";
import { computeWorkCorrelationDecisionFingerprint } from "../../../../core/tact-execution/correlation/fingerprint";
import type { WorkCorrelationDecision } from "../../../../core/tact-execution/correlation/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function decision(overrides: Partial<WorkCorrelationDecision> = {}): WorkCorrelationDecision {
  return {
    executionId: "exec-1", status: "matched", workId: "work-1", method: "structural", confidence: 0.9,
    reasonCode: "slack_thread_match", correlatorVersion: "work-correlator-v1", candidateWorkIds: ["work-1"],
    correlatedAt: "2026-09-20T12:00:01.000Z", ...overrides,
  };
}

function rpcClient(results: Array<{ data: unknown; error: { message: string } | null }>, calls: Array<{ name: string; args: Record<string, unknown> }>): SupabaseClient {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return results.shift() ?? { data: null, error: { message: "unexpected rpc" } };
  } } as unknown as SupabaseClient;
}

function deps(results: Array<{ data: unknown; error: { message: string } | null }>, calls: Array<{ name: string; args: Record<string, unknown> }>): PersistWorkCorrelationDecisionDeps {
  return { getClient: () => rpcClient(results, calls) };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const input = decision();
    const outcome = await persistWorkCorrelationDecision(input, "user-1", deps([{ data: { outcome: "correlated" }, error: null }], calls));
    results.push(check("[Auto/RPC] successful match uses one atomic RPC with the semantic fingerprint",
      outcome.status === "persisted" && calls.length === 1 && calls[0].name === "apply_execution_work_correlation" &&
      calls[0].args.p_execution_id === "exec-1" && calls[0].args.p_user_id === "user-1" &&
      calls[0].args.p_target_work_id === "work-1" && calls[0].args.p_decision_fingerprint === computeWorkCorrelationDecisionFingerprint(input)));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistWorkCorrelationDecision(decision(), "user-1", deps([{ data: { outcome: "already_same_work", workId: "work-1" }, error: null }], calls));
    results.push(check("[Auto/retry] same Work retry is accepted as already_same_work without a local history insert", outcome.status === "persisted" && calls.length === 1));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistWorkCorrelationDecision(decision({ workId: "work-loser" }), "user-1", deps([{ data: { outcome: "conflict_existing_other_work", currentWorkId: "work-winner" }, error: null }], calls));
    results.push(check("[Auto/race] a different-Work CAS loser is not reported as success", outcome.status === "conflict_existing_other_work" && outcome.currentWorkId === "work-winner"));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistWorkCorrelationDecision(decision({ status: "ambiguous", workId: null, candidateWorkIds: ["work-b", "work-a"] }), "user-1", deps([{ data: { outcome: "duplicate_decision" }, error: null }], calls));
    results.push(check("[Ambiguous/idempotency] duplicate_decision creates no local retry", outcome.status === "duplicate_decision" && calls.length === 1));
  }

  {
    const first = computeWorkCorrelationDecisionFingerprint(decision({ status: "unresolved", workId: null, candidateWorkIds: ["work-b", "work-a"] }));
    const reordered = computeWorkCorrelationDecisionFingerprint(decision({ status: "unresolved", workId: null, candidateWorkIds: ["work-a", "work-b"] }));
    const changedCandidates = computeWorkCorrelationDecisionFingerprint(decision({ status: "unresolved", workId: null, candidateWorkIds: ["work-a", "work-c"] }));
    const changedVersion = computeWorkCorrelationDecisionFingerprint(decision({ status: "unresolved", workId: null, candidateWorkIds: ["work-a", "work-b"], correlatorVersion: "work-correlator-v2" }));
    results.push(check("[Fingerprint] candidate ordering is idempotent; changed candidates or version are new decisions", first === reordered && first !== changedCandidates && first !== changedVersion));
  }

  for (const expected of ["execution_not_found", "target_work_not_found", "target_work_not_correlatable"] as const) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistWorkCorrelationDecision(decision(), "user-1", deps([{ data: { outcome: expected }, error: null }], calls));
    results.push(check(`[Auto/validation] ${expected} is not a persisted result`, outcome.status === expected));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistWorkCorrelationDecision(decision(), "user-1", deps([{ data: null, error: { message: "transaction failed" } }], calls));
    results.push(check("[Auto/rollback] an RPC failure is never reported as persisted", outcome.status === "error" && calls.length === 1));
  }

  return summarize("TACT Canonical Execution — Transactional Work Correlation RPC", results);
}
