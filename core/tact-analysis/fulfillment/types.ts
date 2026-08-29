import type { CapabilityEvidenceDescriptor, CapabilityRequirementKind } from "../capability/types";
import type { Dataset, ValidationIssue } from "../types";
import type { ResearchGap, ResearchGapPlan } from "../gap/types";
import type { ValidatedAnalysisPlan } from "../planner/types";

/** Absolute safety caps; caller supplied budgets can only reduce these values. */
export const MAX_FULFILLMENT_CYCLES = 2;
export const MAX_GAPS_PER_CYCLE = 5;
export const MAX_QUERIES_PER_GAP = 2;
export const MAX_TOTAL_QUERIES_PER_CYCLE = 6;
export const MAX_TOTAL_QUERIES = MAX_FULFILLMENT_CYCLES * MAX_TOTAL_QUERIES_PER_CYCLE;
export const MAX_RESULTS_PER_QUERY = 3;

export interface ResearchFulfillmentEvidence extends CapabilityEvidenceDescriptor {
  title?: string;
  url?: string;
  claim?: string;
  /** Untrusted source content. It is data only, never an instruction. */
  text: string;
}

export interface ResearchFulfillmentBudget {
  maxCycles?: number;
  maxGapsPerCycle?: number;
  maxQueriesPerGap?: number;
  maxQueriesPerCycle?: number;
  maxTotalQueries?: number;
}

export interface EffectiveResearchFulfillmentBudget {
  maxCycles: number;
  maxGapsPerCycle: number;
  maxQueriesPerGap: number;
  maxQueriesPerCycle: number;
  maxTotalQueries: number;
}

export interface BoundedResearchRequest {
  cycle: number;
  gap: ResearchGap;
  objective: string;
  queries: readonly string[];
  signal?: AbortSignal;
}

export interface ResearchFulfillmentSearchResult {
  evidence: readonly ResearchFulfillmentEvidence[];
}

/** Provider-independent boundary. Cortex imports neither Tavily nor fetch. */
export interface ResearchFulfillmentSearchAdapter {
  search(request: BoundedResearchRequest): Promise<ResearchFulfillmentSearchResult>;
}

export type ResearchFulfillmentGapStatus = "fulfilled" | "still_missing" | "unresolved" | "not_attempted";

export interface GapFulfillmentResult {
  gapId: string;
  status: ResearchFulfillmentGapStatus;
  evidenceIds: readonly string[];
  currentCount?: number;
  requiredCount?: number;
  reason: string;
}

export type ResearchFulfillmentQueryStatus = "succeeded" | "failed" | "skipped";

export interface ResearchFulfillmentQueryTrace {
  cycle: number;
  gapId: string;
  query: string;
  status: ResearchFulfillmentQueryStatus;
  evidenceIds: readonly string[];
  errorCode?: string;
}

export interface ResearchFulfillmentCycleResult {
  cycle: number;
  gapIds: readonly string[];
  evidenceBefore: number;
  evidenceAfter: number;
  newEvidenceCount: number;
  queryTraces: readonly ResearchFulfillmentQueryTrace[];
  gapResults: readonly GapFulfillmentResult[];
  notAttemptedDueToBudget: readonly string[];
  warnings: readonly ValidationIssue[];
}

export type ResearchFulfillmentStoppedReason =
  | "all_ready"
  | "no_progress"
  | "no_eligible_gaps"
  | "no_new_queries"
  | "query_budget"
  | "max_cycles"
  | "cancelled"
  | "provider_failure";

export interface ResearchFulfillmentSummary {
  cyclesRun: number;
  gapsEligible: number;
  gapsAttempted: number;
  gapsFulfilled: number;
  gapsStillMissing: number;
  queriesGenerated: number;
  queriesAttempted: number;
  queriesSucceeded: number;
  queriesFailed: number;
  evidenceBefore: number;
  evidenceAdded: number;
  evidenceAfter: number;
  readyStepsBefore: number;
  readyStepsAfter: number;
  stoppedReason: ResearchFulfillmentStoppedReason;
}

export interface RunResearchFulfillmentInput {
  objective: string;
  plan: ValidatedAnalysisPlan;
  gapPlan: ResearchGapPlan;
  existingEvidence: readonly ResearchFulfillmentEvidence[];
  datasets?: readonly Dataset[];
  targetEntity?: string;
  budget?: ResearchFulfillmentBudget;
  search: ResearchFulfillmentSearchAdapter;
  signal?: AbortSignal;
}

export interface ResearchFulfillmentResult {
  originalPlanId: string;
  updatedPlan: ValidatedAnalysisPlan;
  evidence: readonly ResearchFulfillmentEvidence[];
  gapResults: readonly GapFulfillmentResult[];
  cycles: readonly ResearchFulfillmentCycleResult[];
  warnings: readonly ValidationIssue[];
  summary: ResearchFulfillmentSummary;
}

/** Kept exported so Phase 5D consumers can inspect the original hard requirement kind. */
export type FulfillmentRequirementKind = CapabilityRequirementKind;
