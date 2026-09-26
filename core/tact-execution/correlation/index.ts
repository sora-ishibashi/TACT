export * from "./types";
export { resolveCorrelationContext } from "./context";
export { runExplicitCorrelation } from "./stages/explicit";
export {
  runStructuralCorrelation,
  defaultStructuralCorrelationDeps,
  type StructuralCorrelationDeps,
} from "./stages/structural";
export {
  resolveTemporalParticipantCandidates,
  defaultTemporalParticipantCandidateDeps,
  type TemporalParticipantCandidateDeps,
} from "./stages/temporalParticipant";
export { runAiAssistedCorrelation } from "./stages/aiAssisted";
export {
  correlateExecution,
  defaultCorrelateExecutionDeps,
  type CorrelateExecutionDeps,
} from "./correlate";
export {
  persistWorkCorrelationDecision,
  persistManualWorkCorrelationOverride,
  listWorkCorrelationDecisionsForExecution,
  listLatestCorrelationMethodsForExecutions,
  getExecutionCorrelationView,
  getExecutionCorrectionContext,
  toWorkCorrelationDecision,
  validateWorkCorrelationDecision,
  type PersistWorkCorrelationDecisionOutcome,
  type PersistWorkCorrelationDecisionDeps,
  type PersistManualWorkCorrelationOverrideInput,
  type PersistManualWorkCorrelationOverrideOutcome,
  type PersistManualWorkCorrelationOverrideDeps,
  type WorkCorrelationDecisionRow,
  type ExecutionCorrelationView,
  type GetExecutionCorrelationViewDeps,
  type ExecutionCorrectionContext,
  type ExecutionCorrection,
  type ExecutionCorrectionPrediction,
  type GetExecutionCorrectionContextDeps,
} from "./store";
export {
  observeExecutionWorkCorrelation,
  type ObserveExecutionWorkCorrelationOutcome,
  type ObserveExecutionWorkCorrelationDeps,
} from "./observe";
export {
  toCanonicalCorrelationResult,
  toCanonicalExecutionCorrelationStatus,
  CANONICAL_CORRELATION_RESULTS,
  type CanonicalCorrelationResult,
} from "./canonicalResult";
export { CORRELATOR_VERSION } from "./version";
export {
  EXPLICIT_CONFIDENCE,
  STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE,
  STRUCTURAL_AMBIGUOUS_CONFIDENCE,
  AI_ASSISTED_AMBIGUOUS_CONFIDENCE,
} from "./confidencePolicy";
