import { enrichFrameworkWithInference } from "../framework/inference";
import { reviewFrameworkInferences } from "../framework/reviewer";
import type { FrameworkResult } from "../framework/types";
import type { NumericEvidenceSource } from "../research/types";
import type { AnalysisResult, ValidationIssue } from "../types";
import { MAX_ANALYSIS_EXECUTION_STEPS, type AnalysisExecutionSummary, type AnalysisExecutionTrace, type AnalysisPlanExecutionResult, type AnalysisStepExecutionResult, type AnalysisStepExecutionStatus, type ExecuteAnalysisPlanInput } from "./types";
import { buildExecutionInput } from "./inputBuilder";
import { orderAnalysisSteps } from "./ordering";

function issue(code: string, message: string): ValidationIssue { return { code, severity: "error", message }; }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function now(): string { return new Date().toISOString(); }
function evidenceSources(evidence: ExecuteAnalysisPlanInput["evidence"]): NumericEvidenceSource[] { return evidence.map((item) => ({ id: item.id, claim: item.text ?? "", text: item.text })); }

function stepResult(step: ExecuteAnalysisPlanInput["plan"]["steps"][number], status: AnalysisStepExecutionStatus, warnings: readonly ValidationIssue[] = [], output?: AnalysisResult, sourceEvidenceIds: readonly string[] = []): AnalysisStepExecutionResult {
  return { stepId: step.id, capabilityId: step.capabilityId, ruleId: step.ruleId, ruleVersion: step.ruleVersion, status, ...(output ? { output } : {}), warnings, sourceEvidenceIds: unique(sourceEvidenceIds) };
}

function presentationResult(step: ExecuteAnalysisPlanInput["plan"]["steps"][number], input: { datasetId: string; type: string; block: unknown; warnings: ValidationIssue[] }, sourceEvidenceIds: string[]): AnalysisResult {
  const timestamp = now();
  return { id: crypto.randomUUID(), rule: { id: step.ruleId, version: step.ruleVersion }, status: input.warnings.some((warning) => warning.severity === "error") ? "partial" : "success", output: { ...input, sourceEvidenceIds }, sourceEvidenceIds, warnings: input.warnings, trace: { startedAt: timestamp, completedAt: timestamp, deterministic: true, llmUsed: false, inputIds: [input.datasetId] } };
}

function summary(steps: readonly AnalysisStepExecutionResult[]): AnalysisExecutionSummary {
  return { plannedSteps: steps.length, completed: steps.filter((step) => step.status === "completed").length, skippedBlocked: steps.filter((step) => step.status === "skipped_blocked").length, skippedDependency: steps.filter((step) => step.status === "skipped_dependency").length, failedValidation: steps.filter((step) => step.status === "failed_validation").length, failedExecution: steps.filter((step) => step.status === "failed_execution").length, cancelled: steps.filter((step) => step.status === "cancelled").length };
}

function overall(result: AnalysisExecutionSummary): AnalysisPlanExecutionResult["status"] {
  if (result.cancelled > 0) return "cancelled";
  if (result.completed === result.plannedSteps && result.plannedSteps > 0) return "completed";
  if (result.completed > 0) return "partially_completed";
  if (result.failedExecution > 0 || result.failedValidation > 0) return "failed";
  return "blocked";
}

/** Executes only the already-validated plan allowlist. It does not plan, search, fulfill, persist, or synthesize. */
export async function executeAnalysisPlan(input: ExecuteAnalysisPlanInput): Promise<AnalysisPlanExecutionResult> {
  const selected = input.plan.steps.slice(0, MAX_ANALYSIS_EXECUTION_STEPS);
  const overflow = input.plan.steps.slice(MAX_ANALYSIS_EXECUTION_STEPS);
  const order = orderAnalysisSteps(selected);
  const results = new Map<string, AnalysisStepExecutionResult>();
  const trace: AnalysisExecutionTrace[] = [];
  const warnings: ValidationIssue[] = overflow.map((step) => issue("EXECUTION_STEP_LIMIT", `Step ${step.id} exceeds the absolute execution limit`));
  for (const step of overflow) results.set(step.id, stepResult(step, "failed_validation", [issue("EXECUTION_STEP_LIMIT", "Execution is capped at five planned steps")]));

  for (const step of order.ordered) {
    const startedAt = now();
    let result: AnalysisStepExecutionResult;
    if (input.signal?.aborted) result = stepResult(step, "cancelled", [{ code: "EXECUTION_CANCELLED", severity: "warning", message: "Execution was cancelled before this step" }]);
    else if (step.status !== "ready") result = stepResult(step, "skipped_blocked", step.evaluation.issues, undefined, input.evidence.map((e) => e.id));
    else if (order.unknownDependencies.has(step.id) || order.cyclicStepIds.includes(step.id)) result = stepResult(step, "failed_validation", [issue(order.cyclicStepIds.includes(step.id) ? "DEPENDENCY_CYCLE" : "UNKNOWN_DEPENDENCY", "Plan dependency is invalid")]);
    else if (step.dependsOn.some((dependency) => results.get(dependency)?.status !== "completed")) result = stepResult(step, "skipped_dependency", [{ code: "DEPENDENCY_NOT_COMPLETED", severity: "warning", message: "A required dependency did not complete" }]);
    else {
      const capability = input.capabilityRegistry.get(step.capabilityId);
      if (!capability) result = stepResult(step, "failed_validation", [issue("UNKNOWN_CAPABILITY", `Capability ${step.capabilityId} is not registered`)]);
      else if (capability.rule.id !== step.ruleId || capability.rule.version !== step.ruleVersion) result = stepResult(step, "failed_validation", [issue("RULE_VERSION_MISMATCH", "Plan Rule mapping does not match the registered Capability")]);
      else {
        const applicability = capability.evaluate({ objective: input.plan.objective, targetEntity: input.targetEntity, evidence: input.evidence, datasets: input.datasets, explicitCapabilityId: step.capabilityId, explicitRequest: step.evaluation.explicitRequest });
        if (!applicability.valid || !applicability.executable) result = stepResult(step, "failed_validation", [{ code: "STALE_PLAN", severity: "error", message: "Current input no longer satisfies this ready plan step" }, ...applicability.issues]);
        else {
          const built = buildExecutionInput(step, input.plan.objective, input.datasets, input.evidence, input.targetEntity, input.explicitInputs);
          if (!built.ok) result = stepResult(step, "failed_validation", built.issues);
          else if (step.capabilityId.startsWith("presentation.")) {
            const output = presentationResult(step, built.input as { datasetId: string; type: string; block: unknown; warnings: ValidationIssue[] }, built.sourceEvidenceIds);
            result = output.warnings.some((warning) => warning.severity === "error") ? stepResult(step, "failed_validation", output.warnings) : stepResult(step, "completed", output.warnings, output, output.sourceEvidenceIds);
          } else {
            const rule = input.registry.get(step.ruleId, step.ruleVersion);
            if (!rule) result = stepResult(step, "failed_validation", [issue("UNKNOWN_RULE", `Rule ${step.ruleId}@${step.ruleVersion} is not registered`)]);
            else {
              let output = await input.registry.execute(step.ruleId, built.input, { version: step.ruleVersion, inputIds: [step.id], sourceEvidenceIds: built.sourceEvidenceIds });
              const canEnrichFramework = Boolean(input.frameworkInferenceProvider || input.frameworkInferenceRunLLM);
              const canReviewFramework = Boolean(input.frameworkReviewerProvider || input.frameworkReviewerRunLLM);
              if (step.capabilityId.startsWith("framework.") && output.output && output.status !== "failed" && step.evaluation.explicitRequest && canEnrichFramework) {
                const facts = output.output as FrameworkResult;
                const sources = evidenceSources(input.evidence);
                const enriched = await enrichFrameworkWithInference(facts, input.plan.objective, sources, { provider: input.frameworkInferenceProvider, model: input.frameworkInferenceModel, runLLMImpl: input.frameworkInferenceRunLLM });
                const reviewed = canReviewFramework
                  ? await reviewFrameworkInferences(enriched.result, input.plan.objective, sources, { provider: input.frameworkReviewerProvider, model: input.frameworkReviewerModel, runLLMImpl: input.frameworkReviewerRunLLM })
                  : { result: enriched.result, summary: { generated: enriched.inference.acceptedCount, reviewed: 0, supported: 0, partiallySupported: 0, unsupported: 0, invalid: 0, failed: false, llmUsed: false } };
                const frameworkWarnings = [...output.warnings, ...enriched.inference.warnings, ...(reviewed.result.reviewResult?.warnings ?? [])];
                output = { ...output, output: reviewed.result, warnings: frameworkWarnings, status: frameworkWarnings.some((warning) => warning.severity === "error") ? "partial" : output.status, sourceEvidenceIds: unique([...output.sourceEvidenceIds, ...reviewed.result.sourceEvidenceIds]), trace: { ...output.trace, deterministic: !(enriched.inference.llmUsed || reviewed.summary.llmUsed), llmUsed: enriched.inference.llmUsed || reviewed.summary.llmUsed } };
              }
              const errors = output.warnings.some((warning) => warning.severity === "error");
              result = output.status === "failed" ? stepResult(step, "failed_execution", output.warnings, undefined, output.sourceEvidenceIds) : errors ? stepResult(step, "failed_validation", output.warnings, undefined, output.sourceEvidenceIds) : stepResult(step, "completed", output.warnings, output, output.sourceEvidenceIds);
            }
          }
        }
      }
    }
    results.set(step.id, result);
    trace.push({ stepId: step.id, status: result.status, startedAt, completedAt: now(), dependencyStepIds: step.dependsOn });
  }
  for (const step of selected.filter((candidate) => order.cyclicStepIds.includes(candidate.id))) if (!results.has(step.id)) {
    const result = stepResult(step, "failed_validation", [issue("DEPENDENCY_CYCLE", "Plan dependency cycle prevents execution")]); results.set(step.id, result); trace.push({ stepId: step.id, status: result.status, startedAt: now(), completedAt: now(), dependencyStepIds: step.dependsOn });
  }
  const steps = input.plan.steps.map((step) => results.get(step.id) ?? stepResult(step, "failed_validation", [issue("EXECUTION_INTERNAL_ERROR", "No execution result was produced")]));
  const executionSummary = summary(steps);
  return { planId: input.plan.id, status: overall(executionSummary), steps, outputs: steps.flatMap((step) => step.status === "completed" && step.output ? [step.output] : []), warnings: unique([...warnings, ...steps.flatMap((step) => step.warnings)]), trace, summary: executionSummary };
}
