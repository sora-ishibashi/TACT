import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFrameworkInferenceRequest, enrichFrameworkWithInference, validateAndMergeFrameworkInferences } from "../../../core/tact-analysis/framework/inference";
import type { FrameworkResult } from "../../../core/tact-analysis/framework/types";
import { check, summarize, type CheckResult } from "../lib/check";

const base: FrameworkResult = {
  frameworkId: "framework.swot", frameworkVersion: "1", sourceEvidenceIds: ["ev1", "ev2", "ev3"], warnings: [],
  sections: [
    { id: "strength", label: "Strength", sourceEvidenceIds: ["ev1", "ev3"], items: [{ id: "fact-1", sectionId: "strength", kind: "fact", text: "A社 company strength: 100 users", sourceEvidenceIds: ["ev1"], confidence: "medium" }, { id: "fact-3", sectionId: "strength", kind: "fact", text: "A社 company strength: customer base", sourceEvidenceIds: ["ev3"], confidence: "medium" }] },
    { id: "weakness", label: "Weakness", sourceEvidenceIds: [], items: [] },
    { id: "opportunity", label: "Opportunity", sourceEvidenceIds: ["ev2"], items: [{ id: "fact-2", sectionId: "opportunity", kind: "fact", text: "external opportunity: market growth", sourceEvidenceIds: ["ev2"], confidence: "medium" }] },
    { id: "threat", label: "Threat", sourceEvidenceIds: [], items: [] },
  ],
};
const evidence = [{ id: "ev1", claim: "", text: "A社 company strength: 100 users" }, { id: "ev2", claim: "", text: "external opportunity: market growth" }, { id: "ev3", claim: "", text: "A社 company strength: customer base" }];

export async function run() {
  const checks: CheckResult[] = [];
  const request = buildFrameworkInferenceRequest(base, "SWOT analysis for A社", evidence)!;
  const merged = validateAndMergeFrameworkInferences(base, request, [
    { sectionId: "strength", text: "A社 customer base suggests an internal strength", sourceEvidenceIds: ["ev1"], confidence: "medium" },
    { sectionId: "strength", text: "A社 customer base suggests an internal strength", sourceEvidenceIds: ["ev3"], confidence: "medium" },
    { sectionId: "unknown", text: "unsupported", sourceEvidenceIds: ["ev1"] },
    { sectionId: "strength", text: "", sourceEvidenceIds: ["ev1"] },
    { sectionId: "strength", text: "fake source", sourceEvidenceIds: ["fake"] },
    { sectionId: "strength", text: "A社 has 150 users", sourceEvidenceIds: ["ev1"] },
    { sectionId: "strength", text: "B社 has 100 users", sourceEvidenceIds: ["ev1"] },
    JSON.parse('{"sectionId":"strength","text":"invalid confidence","sourceEvidenceIds":["ev1"],"confidence":"certain"}'),
    { sectionId: "opportunity", text: "market growth may be a tailwind", sourceEvidenceIds: ["ev1"] },
  ]);
  const strength = merged.result.sections[0];
  checks.push(check("[Contract] valid candidate accepted and duplicate provenance merged", merged.acceptedCount === 1 && strength.items.filter((item) => item.kind === "inference")[0]?.sourceEvidenceIds.join(",") === "ev1,ev3"));
  checks.push(check("[Validation] section, evidence, confidence, number, name, and boundary guards reject", ["FRAMEWORK_INFERENCE_INVALID_SECTION", "FRAMEWORK_INFERENCE_EMPTY", "FRAMEWORK_INFERENCE_INVALID_EVIDENCE", "FRAMEWORK_INFERENCE_UNSUPPORTED_NUMBER", "FRAMEWORK_INFERENCE_UNSUPPORTED_PROPER_NOUN", "FRAMEWORK_INFERENCE_INVALID_CONFIDENCE", "FRAMEWORK_INFERENCE_SECTION_BOUNDARY"].every((code) => merged.warnings.some((warning) => warning.code === code))));
  const limited = validateAndMergeFrameworkInferences(base, request, Array.from({ length: 9 }, (_, index) => ({ sectionId: "strength", text: `supported inference ${String.fromCharCode(97 + index)}`, sourceEvidenceIds: ["ev1"] })));
  checks.push(check("[Limit] at most three inferences per section are accepted", limited.acceptedCount === 3 && limited.warnings.some((warning) => warning.code === "FRAMEWORK_INFERENCE_LIMIT_REACHED")));
  const threeC: FrameworkResult = { ...base, frameworkId: "framework.3c", sections: [{ id: "customer", label: "Customer", sourceEvidenceIds: ["ev1"], items: [{ id: "customer-fact", sectionId: "customer", kind: "fact", text: "customer demand", sourceEvidenceIds: ["ev1"] }] }] };
  const pest: FrameworkResult = { ...base, frameworkId: "framework.pest", sections: [{ id: "political", label: "Political", sourceEvidenceIds: ["ev2"], items: [{ id: "policy-fact", sectionId: "political", kind: "fact", text: "policy support", sourceEvidenceIds: ["ev2"] }] }] };
  const threeCMerged = validateAndMergeFrameworkInferences(threeC, buildFrameworkInferenceRequest(threeC, "3C analysis", evidence)!, [{ sectionId: "customer", text: "customer demand may grow", sourceEvidenceIds: ["ev1"] }]);
  const pestMerged = validateAndMergeFrameworkInferences(pest, buildFrameworkInferenceRequest(pest, "PEST analysis", evidence)!, [{ sectionId: "political", text: "policy support may help adoption", sourceEvidenceIds: ["ev2"] }]);
  checks.push(check("[3C/PEST] supported inference remains in the declared section", threeCMerged.acceptedCount === 1 && pestMerged.acceptedCount === 1));
  let calls = 0;
  const enriched = await enrichFrameworkWithInference(base, "SWOT analysis for A社", evidence, { runLLMImpl: async () => { calls += 1; return { content: JSON.stringify({ inferences: [{ sectionId: "opportunity", text: "market growth may be a tailwind", sourceEvidenceIds: ["ev2"], confidence: "low" }] }) }; } });
  checks.push(check("[LLM] exactly one structured mock call enriches only validated output", calls === 1 && enriched.inference.acceptedCount === 1 && enriched.result.sections[2].items.some((item) => item.kind === "inference")));
  let noFactCalls = 0;
  const noFacts = await enrichFrameworkWithInference({ ...base, sections: base.sections.map((section) => ({ ...section, items: [] })), sourceEvidenceIds: [] }, "SWOT analysis", evidence, { runLLMImpl: async () => { noFactCalls += 1; return { content: "{}" }; } });
  checks.push(check("[Policy] no fact means no LLM call", noFactCalls === 0 && noFacts.inference.attempted === false));
  const failed = await enrichFrameworkWithInference(base, "SWOT analysis", evidence, { runLLMImpl: async () => { throw new Error("mock provider failure"); } });
  checks.push(check("[Fallback] provider failure preserves fact-only result", failed.result.sections[0].items.length === base.sections[0].items.length && failed.inference.warnings.some((warning) => warning.code === "FRAMEWORK_INFERENCE_FAILED")));
  return summarize("cortexFrameworkInference", checks);
}

const direct = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (direct === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
