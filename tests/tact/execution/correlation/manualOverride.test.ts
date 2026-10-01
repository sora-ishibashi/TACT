// =========================
// TACT Canonical Execution — Transactional Manual Reclassification RPC
// =========================
import type { SupabaseClient } from "@supabase/supabase-js";
import { persistManualWorkCorrelationOverride, type PersistManualWorkCorrelationOverrideDeps, type PersistManualWorkCorrelationOverrideInput } from "@tact/runs-core/tact-execution/correlation/store";
import { check, summarize, type CheckResult } from "../../lib/check";

function input(overrides: Partial<PersistManualWorkCorrelationOverrideInput> = {}): PersistManualWorkCorrelationOverrideInput {
  return {
    executionId: "exec-1", userId: "user-1", expectedPreviousWorkId: "work-old", newWorkId: "work-new",
    changedBy: { kind: "human", id: "actor-1" }, reasonCode: "human_corrected_misclassification", ...overrides,
  };
}

function rpcDeps(result: { data: unknown; error: { message: string } | null }, calls: Array<{ name: string; args: Record<string, unknown> }>): PersistManualWorkCorrelationOverrideDeps {
  return { getClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args }); return result;
  } } as unknown as SupabaseClient) };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistManualWorkCorrelationOverride(input(), rpcDeps({ data: { outcome: "reclassified", workId: "work-new", correlationStatus: "matched", previousWorkId: "work-old" }, error: null }, calls));
    results.push(check("[Manual/RPC] actor, expected previous Work and new Work are sent to the one transactional RPC",
      outcome.status === "reclassified" && outcome.previousWorkId === "work-old" && outcome.decision.method === "manual_override" &&
      outcome.decision.changedByActorId === "actor-1" && calls.length === 1 && calls[0].name === "reclassify_execution_work" &&
      calls[0].args.p_expected_previous_work_id === "work-old" && calls[0].args.p_new_work_id === "work-new"));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistManualWorkCorrelationOverride(input(), rpcDeps({ data: { outcome: "stale_revision", actualWorkId: "work-winner" }, error: null }, calls));
    results.push(check("[Manual/concurrency] a stale concurrent override is rejected rather than silently overwriting", outcome.status === "stale_revision" && outcome.actualWorkId === "work-winner"));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistManualWorkCorrelationOverride(input({ newWorkId: null }), rpcDeps({ data: { outcome: "reclassified", workId: null, correlationStatus: "unresolved", previousWorkId: "work-old" }, error: null }, calls));
    results.push(check("[Manual/unassign] null Work becomes unresolved and preserves previous Work", outcome.status === "reclassified" && outcome.decision.status === "unresolved" && outcome.decision.workId === null && outcome.previousWorkId === "work-old"));
  }

  for (const expected of ["execution_not_found", "target_work_not_found", "target_work_not_correlatable"] as const) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistManualWorkCorrelationOverride(input(), rpcDeps({ data: { outcome: expected }, error: null }, calls));
    results.push(check(`[Manual/validation] ${expected} is rejected without success`, outcome.status === expected));
  }

  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await persistManualWorkCorrelationOverride(input(), rpcDeps({ data: null, error: { message: "history insert failed" } }, calls));
    results.push(check("[Manual/rollback] an RPC error cannot be reported as reclassified", outcome.status === "error" && calls.length === 1));
  }

  return summarize("TACT Canonical Execution — Transactional Manual Reclassification RPC", results);
}
