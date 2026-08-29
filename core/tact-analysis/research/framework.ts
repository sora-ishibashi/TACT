import { createFrameworkCortexRegistry } from "../framework/bootstrap";
import type { FrameworkId, FrameworkInput, FrameworkResult, ResearchFrameworkAnalysis } from "../framework/types";
import type { NumericEvidenceSource } from "./types";
import { enrichFrameworkWithInference } from "../framework/inference";
import type { FrameworkRunLLM } from "../framework/inference";
import { reviewFrameworkInferences } from "../framework/reviewer";
import type { FrameworkReviewRunLLM } from "../framework/reviewer";
import type { Provider } from "../../agent/types";
const explanation=/(とは|使い方|について教えて|意味)/; const action=/(分析|整理|見て)/;
export function detectFrameworkIntent(query:string): FrameworkId|undefined { if(explanation.test(query)) return undefined; const ids:[FrameworkId,RegExp][]=[["framework.swot",/swot/i],["framework.3c",/3c/i],["framework.pest",/pest/i]]; const found=ids.filter(([,p])=>p.test(query)&&action.test(query)); return found.length===1?found[0][0]:undefined; }
export async function runResearchFramework(query:string,evidence:readonly NumericEvidenceSource[]):Promise<{frameworks?:ResearchFrameworkAnalysis[];frameworkWarnings?:import("../types").ValidationIssue[]}>{ const id=detectFrameworkIntent(query); if(!id)return {}; const result=await createFrameworkCortexRegistry().execute<FrameworkInput,FrameworkResult>(id,{objective:query,evidence}); const warnings=result.warnings; return {frameworks:[{frameworkId:id,result,warnings}],frameworkWarnings:warnings}; }

/** LLM-assisted enrichment is deliberately separate from the deterministic Framework Rule. */
export async function enrichResearchFrameworks(
  base: Awaited<ReturnType<typeof runResearchFramework>>,
  query: string,
  evidence: readonly NumericEvidenceSource[],
  options: { provider?: Provider; model?: string; runLLMImpl?: FrameworkRunLLM } = {},
): Promise<Awaited<ReturnType<typeof runResearchFramework>>> {
  if (!base.frameworks?.length) return base;
  const frameworks = await Promise.all(base.frameworks.map(async (analysis) => {
    if (!analysis.result?.output) return analysis;
    const enriched = await enrichFrameworkWithInference(analysis.result.output, query, evidence, options);
    const warnings = [...analysis.result.warnings, ...enriched.inference.warnings];
    return { ...analysis, result: { ...analysis.result, output: enriched.result, warnings, status: warnings.some((warning) => warning.severity !== "info") ? "partial" : analysis.result.status }, warnings, inference: enriched.inference };
  }));
  return { frameworks, frameworkWarnings: frameworks.flatMap((analysis) => analysis.warnings) };
}

/** Reviewer enrichment is a separate, fail-closed layer after constrained generation. */
export async function reviewResearchFrameworks(
  base: Awaited<ReturnType<typeof runResearchFramework>>,
  query: string,
  evidence: readonly NumericEvidenceSource[],
  options: { provider?: Provider; model?: string; runLLMImpl?: FrameworkReviewRunLLM } = {},
): Promise<Awaited<ReturnType<typeof runResearchFramework>>> {
  if (!base.frameworks?.length) return base;
  const frameworks = await Promise.all(base.frameworks.map(async (analysis) => {
    if (!analysis.result?.output || !analysis.inference || analysis.inference.acceptedCount === 0) return analysis;
    const reviewed = await reviewFrameworkInferences(analysis.result.output, query, evidence, options);
    const warnings = [...analysis.result.warnings, ...(reviewed.result.reviewResult?.warnings ?? [])];
    return { ...analysis, result: { ...analysis.result, output: reviewed.result, warnings, status: warnings.some((entry) => entry.severity !== "info") ? "partial" : analysis.result.status }, warnings, reviewer: reviewed.summary };
  }));
  return { frameworks, frameworkWarnings: frameworks.flatMap((analysis) => analysis.warnings) };
}
