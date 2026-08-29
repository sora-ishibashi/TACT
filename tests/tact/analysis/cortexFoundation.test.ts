import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CortexRegistry,
  datasetToBarChartBlock,
  datasetToTableBlock,
  isCortexRule,
  isDataset,
  normalizeNumber,
  normalizePeriod,
  validateEvidenceSupport,
  validateNumericConsistency,
  validateSourceCoverage,
  type CortexRule,
  type Dataset,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const sampleDataset: Dataset = {
  id: "revenue-by-company",
  columns: [
    { id: "company", label: "Company", type: "string" },
    { id: "revenue", label: "Revenue", type: "currency", unit: "JPY" },
  ],
  sourceEvidenceIds: ["ev-1", "ev-2"],
  rows: [
    {
      id: "company-a",
      sourceEvidenceIds: ["ev-1"],
      values: {
        company: { raw: "Company A", sourceEvidenceIds: ["ev-1"] },
        revenue: { raw: "¥1,250", normalized: 1250, sourceEvidenceIds: ["ev-1"] },
      },
    },
    {
      id: "company-b",
      sourceEvidenceIds: ["ev-2"],
      values: {
        company: { raw: "Company B", sourceEvidenceIds: ["ev-2"] },
        revenue: { raw: "¥2,500", normalized: 2500, sourceEvidenceIds: ["ev-2"] },
      },
    },
  ],
};

const echoRule: CortexRule<string, string> = {
  id: "test/echo",
  version: "1.0.0",
  category: "data",
  purpose: "Registry contract test rule",
  execution: { deterministic: true, llmMode: "never" },
  requirements: [],
  preconditions(input) {
    return input === "blocked"
      ? [{ code: "BLOCKED", severity: "error", message: "blocked input" }]
      : [];
  },
  execute(input) {
    if (input === "throw") {
      throw new Error("expected execution failure");
    }
    return input.toUpperCase();
  },
  validate(output) {
    if (output === "WARN") {
      return [{ code: "POST_WARNING", severity: "warning", message: "warning output" }];
    }
    if (output === "ERROR") {
      return [{ code: "POST_ERROR", severity: "error", message: "invalid output" }];
    }
    return [];
  },
};

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const registry = new CortexRegistry();
  registry.register(echoRule);

  results.push(check("[Registry1] register/get/list", registry.get("test/echo") === echoRule && registry.list().length === 1));
  results.push(check("[Registry1b] runtime rule guard rejects incomplete input", !isCortexRule({ id: "invalid" })));

  let duplicateRejected = false;
  try {
    registry.register(echoRule);
  } catch {
    duplicateRejected = true;
  }
  results.push(check("[Registry2] duplicate id/version is rejected", duplicateRejected));

  const success = await registry.execute("test/echo", "ok", {
    inputIds: ["input-1"],
    sourceEvidenceIds: ["ev-1", "ev-1"],
  });
  results.push(check("[Registry3] execute success", success.status === "success" && success.output === "OK"));
  results.push(check("[Registry4] trace is deterministic and has no LLM", success.trace.deterministic && !success.trace.llmUsed && success.trace.inputIds[0] === "input-1"));
  results.push(check("[Registry5] evidence IDs are deduplicated", success.sourceEvidenceIds.length === 1 && success.sourceEvidenceIds[0] === "ev-1"));

  const preconditionFailure = await registry.execute("test/echo", "blocked");
  results.push(check("[Registry6] precondition error prevents execution", preconditionFailure.status === "failed" && preconditionFailure.warnings.some((entry) => entry.code === "BLOCKED")));

  const executionFailure = await registry.execute("test/echo", "throw");
  results.push(check("[Registry7] execute failure is captured", executionFailure.status === "failed" && executionFailure.warnings.some((entry) => entry.code === "RULE_EXECUTION_FAILED")));

  const postWarning = await registry.execute("test/echo", "warn");
  const postError = await registry.execute("test/echo", "error");
  results.push(check("[Registry8] post-validation warning is partial", postWarning.status === "partial" && postWarning.warnings[0]?.code === "POST_WARNING"));
  results.push(check("[Registry9] post-validation error is partial with output", postError.status === "partial" && postError.output === "ERROR" && postError.warnings[0]?.code === "POST_ERROR"));

  results.push(check("[Dataset1] runtime guard accepts dataset", isDataset(sampleDataset)));
  const table = datasetToTableBlock(sampleDataset, { order: 3, title: "Revenue" });
  results.push(check("[Dataset2] table preserves whole/row/cell provenance", table.ok && table.block.sourceEvidenceIds?.length === 2 && table.block.rowSourceEvidenceIds?.[0]?.[0] === "ev-1" && table.block.cellSourceEvidenceIds?.[1]?.[1]?.[0] === "ev-2"));

  const numericCases = [
    normalizeNumber("1,250"),
    normalizeNumber("12.5%"),
    normalizeNumber("¥1,250"),
    normalizeNumber("1.5万"),
    normalizeNumber("2億"),
    normalizeNumber("3兆"),
  ];
  results.push(check("[Number1] comma number", numericCases[0].ok && numericCases[0].value.value === 1250));
  results.push(check("[Number2] percentage metadata", numericCases[1].ok && numericCases[1].value.value === 12.5 && numericCases[1].value.unit === "%"));
  results.push(check("[Number3] JPY metadata", numericCases[2].ok && numericCases[2].value.value === 1250 && numericCases[2].value.currency === "JPY"));
  results.push(check("[Number4] Japanese magnitudes", numericCases[3].ok && numericCases[3].value.value === 15000 && numericCases[4].ok && numericCases[4].value.value === 200000000 && numericCases[5].ok && numericCases[5].value.value === 3000000000000));
  results.push(check("[Number5] ambiguous and invalid input are rejected", !normalizeNumber("約1,000").ok && !normalizeNumber("Infinity").ok));

  const year = normalizePeriod("2024年");
  const month = normalizePeriod("2024-01");
  const range = normalizePeriod("2024年1月〜2024年3月");
  results.push(check("[Period1] year point", year.ok && year.value.kind === "point" && year.value.start === "2024-01-01"));
  results.push(check("[Period2] year-month point", month.ok && month.value.kind === "point" && month.value.start === "2024-01-01"));
  results.push(check("[Period3] exact range", range.ok && range.value.kind === "range" && range.value.end === "2024-03-01"));
  results.push(check("[Period4] invalid and ambiguous period are rejected", !normalizePeriod("2024-13").ok && !normalizePeriod("今年").ok));

  const unsupported = validateEvidenceSupport({ claim: "", requiredEvidenceIds: [], availableEvidenceIds: ["ev-1"] });
  results.push(check("[Validation1] missing evidence/claim is unsupported", unsupported.some((entry) => entry.code === "UNSUPPORTED_CLAIM" && entry.severity === "error")));

  const uncovered: Dataset = { ...sampleDataset, sourceEvidenceIds: [], rows: sampleDataset.rows.map((row) => ({ ...row, sourceEvidenceIds: [], values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, { ...value, sourceEvidenceIds: [] }])) })) };
  const coverage = validateSourceCoverage(uncovered);
  results.push(check("[Validation2] source coverage finds missing dataset/row/cell provenance", coverage.some((entry) => entry.code === "SOURCE_COVERAGE_LOW" && entry.severity === "error") && coverage.length > 3));

  const numericIssues = validateNumericConsistency({
    values: [
      { raw: "1", value: 1, unit: "JPY", currency: "JPY", sourceEvidenceIds: ["ev-1"] },
      { raw: "2", value: Number.NaN, unit: "USD", currency: "USD", sourceEvidenceIds: ["ev-2"] },
    ],
    requirePeriod: true,
  });
  results.push(check("[Validation3] numeric validator finds invalid value/unit/currency/period", ["INVALID_NUMERIC_VALUE", "NUMERIC_UNIT_MISMATCH", "NUMERIC_CURRENCY_MISMATCH", "MISSING_PERIOD"].every((code) => numericIssues.some((entry) => entry.code === code))));

  const chart = datasetToBarChartBlock(sampleDataset, { order: 4, labelColumnId: "company", valueColumnId: "revenue" });
  results.push(check("[Presentation1] Dataset converts to existing bar ChartBlock", chart.ok && chart.block.chartType === "bar" && chart.block.data[0]?.value === 1250));
  const unsupportedChart = datasetToBarChartBlock(sampleDataset, { order: 4, labelColumnId: "company", valueColumnId: "company" });
  results.push(check("[Presentation2] unsupported chart input is rejected", !unsupportedChart.ok && unsupportedChart.issues.some((entry) => entry.code === "UNSUPPORTED_CHART_INPUT")));

  return summarize("cortexFoundation", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (directFile === import.meta.url) {
  run().then(({ fail }) => {
    if (fail > 0) {
      process.exitCode = 1;
    }
  });
}
