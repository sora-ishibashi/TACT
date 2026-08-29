import { MAX_FULFILLMENT_CYCLES, MAX_GAPS_PER_CYCLE, MAX_QUERIES_PER_GAP, MAX_TOTAL_QUERIES, MAX_TOTAL_QUERIES_PER_CYCLE, type EffectiveResearchFulfillmentBudget, type ResearchFulfillmentBudget } from "./types";

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value as number), maximum)) : fallback;
}

export function resolveResearchFulfillmentBudget(budget: ResearchFulfillmentBudget | undefined): EffectiveResearchFulfillmentBudget {
  const maxCycles = bounded(budget?.maxCycles, MAX_FULFILLMENT_CYCLES, MAX_FULFILLMENT_CYCLES);
  const maxQueriesPerCycle = bounded(budget?.maxQueriesPerCycle, MAX_TOTAL_QUERIES_PER_CYCLE, MAX_TOTAL_QUERIES_PER_CYCLE);
  return {
    maxCycles,
    maxGapsPerCycle: bounded(budget?.maxGapsPerCycle, MAX_GAPS_PER_CYCLE, MAX_GAPS_PER_CYCLE),
    maxQueriesPerGap: bounded(budget?.maxQueriesPerGap, MAX_QUERIES_PER_GAP, MAX_QUERIES_PER_GAP),
    maxQueriesPerCycle,
    maxTotalQueries: Math.min(bounded(budget?.maxTotalQueries, MAX_TOTAL_QUERIES, MAX_TOTAL_QUERIES), maxCycles * maxQueriesPerCycle),
  };
}
