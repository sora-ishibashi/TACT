import { buildResearchGapPlan } from "../gap/buildGapPlan";
import type { ValidationIssue } from "../types";
import { resolveResearchFulfillmentBudget } from "./budget";
import { evaluateGapFulfillment, buildFulfillmentDatasets, fulfillmentWarnings, reEvaluateAnalysisPlan } from "./evaluateFulfillment";
import { isResearchFulfillmentEligible } from "./eligibility";
import { buildBoundedResearchQueries, normalizeResearchQuery } from "./queryPlan";
import { MAX_RESULTS_PER_QUERY, type ResearchFulfillmentCycleResult, type ResearchFulfillmentEvidence, type ResearchFulfillmentQueryTrace, type ResearchFulfillmentResult, type ResearchFulfillmentStoppedReason, type RunResearchFulfillmentInput } from "./types";

function warning(code: string, message: string): ValidationIssue { return { code, severity: "warning", message }; }
function unique<T>(items: readonly T[]): T[] { return [...new Set(items)]; }
function evidenceKey(item: ResearchFulfillmentEvidence): string { return `${item.url?.trim().toLowerCase() ?? ""}\u0000${item.title?.trim().toLowerCase() ?? ""}\u0000${item.text.trim().replace(/\s+/g, " ").toLowerCase()}`; }
function validEvidence(item: ResearchFulfillmentEvidence): boolean { return Boolean(item.id?.trim() && item.text?.trim()); }

export async function runResearchFulfillment(input: RunResearchFulfillmentInput): Promise<ResearchFulfillmentResult> {
  const budget = resolveResearchFulfillmentBudget(input.budget);
  const warnings: ValidationIssue[] = [];
  const cycles: ResearchFulfillmentCycleResult[] = [];
  const traces: ResearchFulfillmentQueryTrace[] = [];
  const attemptedQueries = new Set<string>();
  const attemptedGapIds = new Set<string>();
  const evidence = input.existingEvidence.filter(validEvidence);
  const evidenceKeys = new Set(evidence.map(evidenceKey));
  let totalQueries = 0;
  let updatedPlan = input.plan;
  let currentGapPlan = input.gapPlan;
  let stoppedReason: ResearchFulfillmentStoppedReason = "max_cycles";
  const readyBefore = input.plan.steps.filter((step) => step.status === "ready").length;

  for (let cycle = 1; cycle <= budget.maxCycles; cycle += 1) {
    if (input.signal?.aborted) { stoppedReason = "cancelled"; break; }
    const eligible = currentGapPlan.gaps.filter(isResearchFulfillmentEligible);
    if (eligible.length === 0) { stoppedReason = currentGapPlan.gaps.length === 0 ? "all_ready" : "no_eligible_gaps"; break; }
    if (totalQueries >= budget.maxTotalQueries) { stoppedReason = "query_budget"; break; }
    const selected = eligible.slice(0, budget.maxGapsPerCycle);
    const notAttemptedDueToBudget = eligible.slice(budget.maxGapsPerCycle).map((gap) => gap.id);
    const before = evidence.length;
    const cycleWarnings: ValidationIssue[] = [];
    const cycleTraces: ResearchFulfillmentQueryTrace[] = [];
    let cycleQueries = 0;
    let providerAttempts = 0;
    let providerFailures = 0;

    for (const gap of selected) {
      if (input.signal?.aborted) { stoppedReason = "cancelled"; break; }
      const queries = buildBoundedResearchQueries(gap, input.objective)
        .slice(0, budget.maxQueriesPerGap)
        .filter((query) => !attemptedQueries.has(normalizeResearchQuery(query)));
      if (queries.length === 0) {
        cycleWarnings.push(warning("FULFILLMENT_NO_NEW_QUERY", `No safe new deterministic query is available for ${gap.id}`));
        continue;
      }
      for (const query of queries) {
        if (cycleQueries >= budget.maxQueriesPerCycle || totalQueries >= budget.maxTotalQueries || input.signal?.aborted) break;
        const normalized = normalizeResearchQuery(query);
        attemptedQueries.add(normalized);
        attemptedGapIds.add(gap.id);
        cycleQueries += 1;
        totalQueries += 1;
        providerAttempts += 1;
        try {
          const result = await input.search.search({ cycle, gap, objective: input.objective, queries: [query], signal: input.signal });
          const additions = result.evidence.filter(validEvidence).slice(0, MAX_RESULTS_PER_QUERY).filter((item) => {
            const key = evidenceKey(item);
            if (evidenceKeys.has(key) || evidence.some((existing) => existing.id === item.id)) return false;
            evidenceKeys.add(key);
            return true;
          });
          evidence.push(...additions);
          const trace: ResearchFulfillmentQueryTrace = { cycle, gapId: gap.id, query, status: "succeeded", evidenceIds: additions.map((item) => item.id) };
          traces.push(trace); cycleTraces.push(trace);
        } catch {
          providerFailures += 1;
          const trace: ResearchFulfillmentQueryTrace = { cycle, gapId: gap.id, query, status: "failed", evidenceIds: [], errorCode: "FULFILLMENT_SEARCH_FAILED" };
          traces.push(trace); cycleTraces.push(trace);
          cycleWarnings.push(warning("FULFILLMENT_SEARCH_FAILED", `Search adapter failed for ${gap.id}; other bounded requests continue`));
        }
      }
    }
    const build = buildFulfillmentDatasets(evidence);
    updatedPlan = reEvaluateAnalysisPlan(input.plan, { objective: input.objective, targetEntity: input.targetEntity, evidence, datasets: build.datasets });
    const gapResults = evaluateGapFulfillment(currentGapPlan.gaps, updatedPlan, evidence);
    const cycleResult: ResearchFulfillmentCycleResult = { cycle, gapIds: selected.map((gap) => gap.id), evidenceBefore: before, evidenceAfter: evidence.length, newEvidenceCount: evidence.length - before, queryTraces: cycleTraces, gapResults, notAttemptedDueToBudget, warnings: [...cycleWarnings, ...fulfillmentWarnings(build.warnings)] };
    cycles.push(cycleResult); warnings.push(...cycleResult.warnings);
    if (input.signal?.aborted) { stoppedReason = "cancelled"; break; }
    if (updatedPlan.executable) { stoppedReason = "all_ready"; break; }
    if (cycleResult.newEvidenceCount === 0) { stoppedReason = providerAttempts > 0 && providerFailures === providerAttempts ? "provider_failure" : "no_progress"; break; }
    currentGapPlan = buildResearchGapPlan({ plan: updatedPlan, targetEntity: input.targetEntity, datasets: build.datasets, evidenceDescriptors: evidence });
    if (cycle === budget.maxCycles) stoppedReason = "max_cycles";
  }
  const finalBuild = buildFulfillmentDatasets(evidence);
  updatedPlan = reEvaluateAnalysisPlan(input.plan, { objective: input.objective, targetEntity: input.targetEntity, evidence, datasets: finalBuild.datasets });
  const finalGapResults = evaluateGapFulfillment(currentGapPlan.gaps, updatedPlan, evidence);
  const succeeded = traces.filter((trace) => trace.status === "succeeded").length;
  const failed = traces.filter((trace) => trace.status === "failed").length;
  return { originalPlanId: input.plan.id, updatedPlan, evidence, gapResults: finalGapResults, cycles, warnings: unique(warnings), summary: {
    cyclesRun: cycles.length, gapsEligible: input.gapPlan.gaps.filter(isResearchFulfillmentEligible).length, gapsAttempted: attemptedGapIds.size,
    gapsFulfilled: finalGapResults.filter((result) => result.status === "fulfilled").length, gapsStillMissing: finalGapResults.filter((result) => result.status === "still_missing").length,
    queriesGenerated: traces.length, queriesAttempted: traces.length, queriesSucceeded: succeeded, queriesFailed: failed,
    evidenceBefore: input.existingEvidence.length, evidenceAdded: evidence.length - input.existingEvidence.filter(validEvidence).length, evidenceAfter: evidence.length,
    readyStepsBefore: readyBefore, readyStepsAfter: updatedPlan.steps.filter((step) => step.status === "ready").length, stoppedReason,
  } };
}
