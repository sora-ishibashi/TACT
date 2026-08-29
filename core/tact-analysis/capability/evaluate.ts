import { evaluatePresentation, inspectPresentationDataset } from "../presentation/evaluatePresentation";
import type { PresentationSuitability, PresentationType } from "../presentation/types";
import type { Dataset, DatasetValue, ValidationIssue } from "../types";
import type {
  AnalysisCapability,
  AnalysisPurpose,
  CapabilityEvaluation,
  CapabilityEvaluationInput,
  CapabilityRequirement,
  CapabilityRequirementKind,
  MissingCapabilityRequirement,
} from "./types";

const suitabilityOrder: Record<PresentationSuitability, number> = {
  "not-recommended": 0,
  low: 1,
  medium: 2,
  high: 3,
};

const required = (id: string, kind: CapabilityRequirementKind, description: string, minCount?: number): CapabilityRequirement =>
  ({ id, kind, description, required: true, minCount });
const recommended = (id: string, kind: CapabilityRequirementKind, description: string): CapabilityRequirement =>
  ({ id, kind, description, required: false });

function explicitRequest(input: CapabilityEvaluationInput, capabilityId: string): boolean {
  return input.explicitRequest === true && (!input.explicitCapabilityId || input.explicitCapabilityId === capabilityId);
}

function missing(requirement: CapabilityRequirement, currentCount?: number): MissingCapabilityRequirement {
  return {
    requirementId: requirement.id,
    kind: requirement.kind,
    description: requirement.description,
    ...(currentCount === undefined ? {} : { currentCount }),
    ...(requirement.minCount === undefined ? {} : { requiredCount: requirement.minCount }),
  };
}

function issueForMissing(requirement: CapabilityRequirement): ValidationIssue {
  return {
    code: "CAPABILITY_REQUIREMENT_MISSING",
    severity: "warning",
    message: `Capability requires ${requirement.description}`,
    path: `requirements.${requirement.id}`,
  };
}

function baseEvaluation(
  capability: Pick<AnalysisCapability, "id">,
  input: CapabilityEvaluationInput,
  satisfiedRequirements: string[],
  missingRequirements: MissingCapabilityRequirement[],
  suitability: PresentationSuitability,
  reasons: string[],
  extraIssues: ValidationIssue[] = [],
): CapabilityEvaluation {
  const objectiveValid = input.objective.trim().length > 0;
  const issues = [...extraIssues];
  if (!objectiveValid) {
    issues.push({ code: "CAPABILITY_INPUT_INVALID", severity: "error", message: "Capability evaluation requires a non-empty objective", path: "objective" });
  }
  for (const requirement of missingRequirements) {
    issues.push(issueForMissing({ id: requirement.requirementId, kind: requirement.kind, required: true, description: requirement.description, minCount: requirement.requiredCount }));
  }
  return {
    capabilityId: capability.id,
    valid: objectiveValid,
    executable: objectiveValid && missingRequirements.length === 0,
    suitability,
    explicitRequest: explicitRequest(input, capability.id),
    satisfiedRequirements,
    missingRequirements,
    reasons,
    issues,
  };
}

function finiteNumber(value: DatasetValue | undefined): boolean {
  const candidate = value?.normalized ?? value?.raw;
  return typeof candidate === "number" && Number.isFinite(candidate);
}

function validNumericCount(dataset: Dataset): number {
  return dataset.rows.reduce((count, row) => count + (finiteNumber(row.values.value) ? 1 : 0), 0);
}

function datasets(input: CapabilityEvaluationInput): readonly Dataset[] {
  return input.datasets ?? [];
}

function bestPresentation(input: CapabilityEvaluationInput, type: PresentationType) {
  const evaluations = datasets(input).map((dataset) => evaluatePresentation(dataset, type));
  return evaluations
    .filter((evaluation) => evaluation.valid)
    .sort((left, right) => suitabilityOrder[right.suitability] - suitabilityOrder[left.suitability])[0];
}

function hasShape(input: CapabilityEvaluationInput, kind: "time-series" | "comparison", minCount: number): boolean {
  return datasets(input).some((dataset) => {
    const shape = inspectPresentationDataset(dataset);
    return shape.kind === kind && shape.rowCount >= minCount && shape.issues.every((issue) => issue.severity !== "error");
  });
}

function calculationCapability(
  id: string,
  name: string,
  description: string,
  purposes: readonly AnalysisPurpose[],
  requirements: readonly CapabilityRequirement[],
  evaluateRequirements: (input: CapabilityEvaluationInput) => { satisfied: string[]; missing: MissingCapabilityRequirement[]; suitability: PresentationSuitability; reasons: string[] },
): AnalysisCapability {
  return {
    id, version: "1", kind: "calculation", name, description, purposes, requirements, rule: { id, version: "1" },
    evaluate(input) {
      const evaluated = evaluateRequirements(input);
      return baseEvaluation(this, input, evaluated.satisfied, evaluated.missing, evaluated.suitability, evaluated.reasons);
    },
  };
}

function presentationCapability(
  id: string,
  name: string,
  type: PresentationType,
  purposes: readonly AnalysisPurpose[],
  inputRequirement: CapabilityRequirement,
): AnalysisCapability {
  return {
    id, version: "1", kind: "presentation", name, description: `Render verified Dataset data as a ${name}`, purposes,
    requirements: [inputRequirement], rule: { id, version: "1" },
    evaluate(input) {
      const recommendation = bestPresentation(input, type);
      if (!recommendation) {
        return baseEvaluation(this, input, [], [missing(inputRequirement, datasets(input).length)], "not-recommended", ["No supplied Dataset is valid for this presentation"]);
      }
      return baseEvaluation(this, input, [inputRequirement.id], [], recommendation.suitability, recommendation.reasons, recommendation.issues);
    },
  };
}

function containsAny(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function frameworkCoverage(input: CapabilityEvaluationInput, categories: readonly (readonly string[])[]): number {
  return categories.reduce((count, terms) => count + (input.evidence?.some((evidence) => containsAny(evidence.text ?? "", terms)) ? 1 : 0), 0);
}

function frameworkCapability(
  id: string,
  name: string,
  description: string,
  purposes: readonly AnalysisPurpose[],
  categories: readonly (readonly string[])[],
): AnalysisCapability {
  const evidenceRequirement = required("evidence", "evidence", "at least one evidence item", 1);
  const entityRequirement = recommended("target-entity", "target_entity", "a target entity or clear target context");
  return {
    id, version: "1", kind: "framework", name, description, purposes, requirements: [evidenceRequirement, entityRequirement], rule: { id, version: "1" },
    evaluate(input) {
      const count = input.evidence?.length ?? 0;
      if (count === 0) {
        return baseEvaluation(this, input, [], [missing(evidenceRequirement, 0)], "not-recommended", ["Framework fact extraction requires evidence; empty sections are otherwise allowed"]);
      }
      const coverage = frameworkCoverage(input, categories);
      const suitability: PresentationSuitability = coverage >= Math.min(3, categories.length) ? "high" : coverage >= 2 ? "medium" : "low";
      const reasons = [
        `Framework has ${count} evidence item${count === 1 ? "" : "s"} for fact extraction`,
        coverage > 0 ? `${coverage} explicit framework signal group${coverage === 1 ? " is" : "s are"} present` : "No explicit framework signal group is present; execution remains fact-only and partial",
      ];
      const satisfied = [evidenceRequirement.id];
      if (input.targetEntity?.trim()) satisfied.push(entityRequirement.id);
      return baseEvaluation(this, input, satisfied, [], suitability, reasons);
    },
  };
}

const numericDatasetRequirement = required("numeric-dataset", "numeric", "at least two finite numeric Dataset values", 2);
const timeSeriesRequirement = required("time-series", "time_series", "a compatible time series with at least two exact periods", 2);
const comparisonRequirement = required("comparison", "comparison", "at least two comparable entities at one metric and period", 2);
const datasetRequirement = required("dataset", "dataset", "a non-empty verified Dataset", 1);

export const analysisCapabilities: readonly AnalysisCapability[] = [
  calculationCapability("calculation.percentage", "Percentage", "Calculate a verified part-to-whole ratio", ["ratio"], [numericDatasetRequirement], (input) => {
    const numericCount = Math.max(0, ...datasets(input).map(validNumericCount));
    return numericCount >= 2
      ? { satisfied: [numericDatasetRequirement.id], missing: [], suitability: "high" as const, reasons: ["A Dataset contains at least two finite numeric values; part and whole must still be selected explicitly"] }
      : { satisfied: [], missing: [missing(numericDatasetRequirement, numericCount)], suitability: "not-recommended" as const, reasons: ["No Dataset has enough verified numeric values for a ratio"] };
  }),
  calculationCapability("calculation.growth-rate", "Growth Rate", "Calculate change between verified temporal values", ["trend"], [timeSeriesRequirement], (input) => {
    const executable = hasShape(input, "time-series", 2);
    return executable
      ? { satisfied: [timeSeriesRequirement.id], missing: [], suitability: "high" as const, reasons: ["A compatible time series has at least two exact temporal points"] }
      : { satisfied: [], missing: [missing(timeSeriesRequirement, 0)], suitability: "not-recommended" as const, reasons: ["Growth rate requires a compatible time series; periods are never inferred"] };
  }),
  calculationCapability("calculation.cagr", "CAGR", "Calculate compound annual growth from verified annual values", ["trend"], [timeSeriesRequirement], (input) => {
    const executable = hasShape(input, "time-series", 2);
    return executable
      ? { satisfied: [timeSeriesRequirement.id], missing: [], suitability: "high" as const, reasons: ["A compatible time series has at least two exact temporal points; numeric domain checks remain in the Rule"] }
      : { satisfied: [], missing: [missing(timeSeriesRequirement, 0)], suitability: "not-recommended" as const, reasons: ["CAGR requires at least two compatible exact annual points"] };
  }),
  calculationCapability("calculation.ranking", "Ranking", "Rank comparable verified numeric entities", ["rank", "compare"], [comparisonRequirement], (input) => {
    const executable = hasShape(input, "comparison", 2);
    return executable
      ? { satisfied: [comparisonRequirement.id], missing: [], suitability: "high" as const, reasons: ["A comparison Dataset contains comparable entities at one metric and period"] }
      : { satisfied: [], missing: [missing(comparisonRequirement, 0)], suitability: "not-recommended" as const, reasons: ["Ranking requires comparable entities; incompatible metrics, periods, units, and currencies are not combined"] };
  }),
  presentationCapability("presentation.table", "Table", "table", ["compare", "summarize", "visualize"], datasetRequirement),
  presentationCapability("presentation.bar", "Bar chart", "bar-chart", ["compare", "visualize"], datasetRequirement),
  presentationCapability("presentation.line", "Line chart", "line-chart", ["trend", "visualize"], timeSeriesRequirement),
  frameworkCapability("framework.swot", "SWOT", "Structure explicit internal and external evidence without filling missing sections", ["structure", "company", "environment"], [["自社", "当社", "company"], ["市場", "規制", "競合", "external", "opportunity", "threat"]]),
  frameworkCapability("framework.3c", "3C", "Structure explicitly signalled customer, competitor, and company evidence", ["company", "customer", "competitor", "market"], [["顧客", "customer"], ["競合", "competitor"], ["自社", "当社", "company"]]),
  frameworkCapability("framework.pest", "PEST", "Structure explicit macro-environment evidence", ["environment", "market"], [["法令", "規制", "政策", "政府", "political"], ["gdp", "物価", "価格", "市場規模", "金利", "為替", "economic"], ["人口", "高齢化", "文化", "価値観", "ライフスタイル", "social"], ["ai", "技術", "自動化", "研究開発", "dx", "technological"]]),
];

/** Deterministic objective metadata only. This never selects or executes a capability. */
export function detectAnalysisPurposes(objective: string): AnalysisPurpose[] {
  const normalized = objective.trim().toLowerCase();
  if (!normalized || /(?:とは|使い方|意味|について教えて|what is|how to use|explain)/i.test(normalized)) return [];
  const matches: [AnalysisPurpose, RegExp][] = [
    ["compare", /比較|比べ|compare/i], ["trend", /推移|成長|増加率|減少率|trend|growth/i], ["ratio", /割合|比率|percentage|ratio/i],
    ["rank", /順位|ランキング|売上順|大きい順|小さい順|ranking|rank/i], ["visualize", /グラフ|可視化|chart|visualize/i],
    ["structure", /swot|3c|pest|整理|structure/i], ["environment", /環境|規制|pest|environment/i], ["market", /市場|market/i],
    ["company", /会社|企業|自社|当社|company/i], ["customer", /顧客|customer/i], ["competitor", /競合|competitor/i], ["summarize", /要約|まとめ|summarize/i],
  ];
  // These compact Japanese signals cover direct comparative/trend questions
  // without turning a definition query into an execution intent.
  const directJapaneseMatches: [AnalysisPurpose, RegExp][] = [
    ["compare", /\u3069\u3061\u3089|\u6bd4\u8f03|\u6bd4\u3079/i],
    ["trend", /\u4f38\u3073|\u6210\u9577|\u63a8\u79fb/i],
  ];
  return [...new Set([...matches, ...directJapaneseMatches].filter(([, pattern]) => pattern.test(normalized)).map(([purpose]) => purpose))];
}

/** Suitability is advisory. A valid, executable explicit request may use a low/medium recommendation. */
export function mayExecuteCapability(evaluation: CapabilityEvaluation): boolean {
  return evaluation.valid && evaluation.executable;
}
