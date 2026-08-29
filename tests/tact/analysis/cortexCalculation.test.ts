import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CortexRegistry,
  createDefaultCortexRegistry,
  type CagrCalculationInput,
  type CalculationResult,
  type CortexRule,
  type GrowthRateCalculationInput,
  type NumericValue,
  type PercentageCalculationInput,
  type RankingCalculationInput,
  type RankingCalculationResult,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

function numeric(value: number, overrides: Partial<NumericValue> = {}): NumericValue {
  return {
    raw: String(value),
    value,
    sourceEvidenceIds: [],
    ...overrides,
  };
}

function hasIssue(result: { warnings: { code: string }[] }, code: string): boolean {
  return result.warnings.some((entry) => entry.code === code);
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const registry = createDefaultCortexRegistry();
  const percentageRule = (input: PercentageCalculationInput) =>
    registry.execute<PercentageCalculationInput, CalculationResult<"percentage">>("calculation.percentage", input);
  const growthRateRule = (input: GrowthRateCalculationInput) =>
    registry.execute<GrowthRateCalculationInput, CalculationResult<"growth-rate">>("calculation.growth-rate", input);
  const cagrRule = (input: CagrCalculationInput) =>
    registry.execute<CagrCalculationInput, CalculationResult<"cagr">>("calculation.cagr", input);
  const rankingRule = (input: RankingCalculationInput) =>
    registry.execute<RankingCalculationInput, RankingCalculationResult>("calculation.ranking", input);

  results.push(check(
    "[Registry1] four calculation rules resolve at version 1",
    ["calculation.percentage", "calculation.growth-rate", "calculation.cagr", "calculation.ranking"]
      .every((id) => registry.get(id, "1") !== undefined) && registry.list().length === 4
  ));

  const percentage = await percentageRule({
    part: numeric(25, { sourceEvidenceIds: ["ev-part", "ev-shared"] }),
    whole: numeric(100, { sourceEvidenceIds: ["ev-whole", "ev-shared"] }),
  });
  results.push(check(
    "[Percentage1] exact ratio and provenance",
    percentage.status === "success" && percentage.output?.value === 0.25 &&
      percentage.output.displayValue === "25%" && percentage.sourceEvidenceIds.join(",") === "ev-part,ev-shared,ev-whole"
  ));

  const percentageDecimal = await percentageRule({
    part: numeric(1), whole: numeric(3), precision: 1,
  });
  results.push(check(
    "[Percentage2] display precision does not round raw result",
    percentageDecimal.status === "success" && percentageDecimal.output?.value === 1 / 3 && percentageDecimal.output.displayValue === "33.3%"
  ));
  const largeGrowth = await growthRateRule({ start: numeric(Number.MAX_VALUE / 2), end: numeric(Number.MAX_VALUE) });
  const tinyPercentage = await percentageRule({ part: numeric(Number.MIN_VALUE), whole: numeric(Number.MIN_VALUE) });
  results.push(check("[Percentage2b] finite large/small values and empty provenance remain deterministic", largeGrowth.status === "success" && largeGrowth.output?.value === 1 && tinyPercentage.status === "success" && tinyPercentage.output?.value === 1 && percentageDecimal.sourceEvidenceIds.length === 0));

  const percentageZero = await percentageRule({ part: numeric(1), whole: numeric(0) });
  const percentageUnits = await percentageRule({
    part: numeric(1, { unit: "kg" }), whole: numeric(10, { unit: "m" }),
  });
  results.push(check("[Percentage3] zero whole is rejected", percentageZero.status === "failed" && hasIssue(percentageZero, "DIVISION_BY_ZERO")));
  results.push(check("[Percentage4] incompatible units are rejected", percentageUnits.status === "failed" && hasIssue(percentageUnits, "NUMERIC_UNIT_MISMATCH")));

  const growth = await growthRateRule({
    start: numeric(100, { sourceEvidenceIds: ["ev-start"] }),
    end: numeric(130, { sourceEvidenceIds: ["ev-end"] }),
  });
  const decline = await growthRateRule({ start: numeric(100), end: numeric(70) });
  results.push(check(
    "[Growth1] positive growth and absolute change",
    growth.status === "success" && growth.output?.value === 0.3 && growth.output.metadata?.absoluteChange === 30 && growth.sourceEvidenceIds.join(",") === "ev-start,ev-end"
  ));
  results.push(check("[Growth2] negative growth remains a ratio", decline.status === "success" && decline.output?.value === -0.3 && decline.output.metadata?.absoluteChange === -30));

  const growthZero = await growthRateRule({ start: numeric(0), end: numeric(30) });
  const growthUnits = await growthRateRule({ start: numeric(1, { unit: "kg" }), end: numeric(2, { unit: "m" }) });
  const growthCurrencies = await growthRateRule({
    start: numeric(1, { unit: "currency", currency: "JPY" }),
    end: numeric(2, { unit: "currency", currency: "USD" }),
  });
  const growthPeriodOrder = await growthRateRule({
    start: numeric(1, { period: { kind: "point", raw: "2024", start: "2024-01-01", granularity: "year" } }),
    end: numeric(2, { period: { kind: "point", raw: "2023", start: "2023-01-01", granularity: "year" } }),
  });
  results.push(check("[Growth3] zero start is rejected", growthZero.status === "failed" && hasIssue(growthZero, "DIVISION_BY_ZERO")));
  results.push(check("[Growth4] unit and currency mismatch are rejected", growthUnits.status === "failed" && hasIssue(growthUnits, "NUMERIC_UNIT_MISMATCH") && growthCurrencies.status === "failed" && hasIssue(growthCurrencies, "NUMERIC_CURRENCY_MISMATCH")));
  results.push(check("[Growth5] reverse chronological periods are rejected", growthPeriodOrder.status === "failed" && hasIssue(growthPeriodOrder, "INVALID_PERIOD_ORDER")));

  const cagr = await cagrRule({ start: numeric(100), end: numeric(169), periods: 2 });
  const cagrDecimal = await cagrRule({ start: numeric(100), end: numeric(110.25), periods: 2, precision: 2 });
  results.push(check("[CAGR1] exact CAGR", cagr.status === "success" && Math.abs((cagr.output?.value ?? 0) - 0.3) < 0.0000001 && cagr.output?.inputs.periods === 2));
  results.push(check("[CAGR2] raw value remains unrounded", cagrDecimal.status === "success" && Math.abs((cagrDecimal.output?.value ?? 0) - 0.05) < 0.0000001 && cagrDecimal.output?.displayValue === "5%"));

  const cagrZeroStart = await cagrRule({ start: numeric(0), end: numeric(1), periods: 1 });
  const cagrNegativeStart = await cagrRule({ start: numeric(-1), end: numeric(1), periods: 1 });
  const cagrNegativeEnd = await cagrRule({ start: numeric(1), end: numeric(-1), periods: 1 });
  const cagrInvalidPeriods = await cagrRule({ start: numeric(1), end: numeric(2), periods: 0 });
  const cagrUnits = await cagrRule({ start: numeric(1, { unit: "kg" }), end: numeric(2, { unit: "m" }), periods: 1 });
  const cagrCurrencies = await cagrRule({
    start: numeric(1, { unit: "currency", currency: "JPY" }),
    end: numeric(2, { unit: "currency", currency: "USD" }), periods: 1,
  });
  results.push(check("[CAGR3] invalid domain and period count are rejected", cagrZeroStart.status === "failed" && cagrNegativeStart.status === "failed" && cagrNegativeEnd.status === "failed" && cagrInvalidPeriods.status === "failed" && hasIssue(cagrInvalidPeriods, "INVALID_PERIOD_COUNT")));
  results.push(check("[CAGR3b] unit and currency mismatch are rejected", cagrUnits.status === "failed" && hasIssue(cagrUnits, "NUMERIC_UNIT_MISMATCH") && cagrCurrencies.status === "failed" && hasIssue(cagrCurrencies, "NUMERIC_CURRENCY_MISMATCH")));

  const cagrDerivedPeriods = await cagrRule({
    start: numeric(100, { sourceEvidenceIds: ["ev-2022"], period: { kind: "point", raw: "2022", start: "2022-01-01", granularity: "year" } }),
    end: numeric(169, { sourceEvidenceIds: ["ev-2024"], period: { kind: "point", raw: "2024", start: "2024-01-01", granularity: "year" } }),
  });
  results.push(check("[CAGR4] exact annual points derive period count and provenance", cagrDerivedPeriods.status === "success" && cagrDerivedPeriods.output?.inputs.periods === 2 && cagrDerivedPeriods.output.metadata?.periodsSource === "derived-annual-points" && cagrDerivedPeriods.sourceEvidenceIds.join(",") === "ev-2022,ev-2024"));

  const rankingInput = {
    items: [
      { id: "A", value: numeric(100, { sourceEvidenceIds: ["ev-a"] }) },
      { id: "B", value: numeric(250, { sourceEvidenceIds: ["ev-b"] }) },
      { id: "C", value: numeric(180, { sourceEvidenceIds: ["ev-c"] }) },
      { id: "D", value: numeric(180, { sourceEvidenceIds: ["ev-d"] }) },
    ],
  };
  const descending = await rankingRule({ ...rankingInput, direction: "descending" });
  const ascending = await rankingRule({ ...rankingInput, direction: "ascending" });
  results.push(check(
    "[Ranking1] descending dense ranking is stable for ties (1,2,2,3)",
    descending.status === "success" && descending.output?.metadata.tieStrategy === "dense" &&
      descending.output.rankings.map((item) => `${item.id}:${item.rank}`).join(",") === "B:1,C:2,D:2,A:3" &&
      descending.sourceEvidenceIds.join(",") === "ev-a,ev-b,ev-c,ev-d" && descending.output.rankings[1]?.sourceEvidenceIds[0] === "ev-c"
  ));
  results.push(check("[Ranking2] ascending ranking", ascending.status === "success" && ascending.output?.rankings.map((item) => `${item.id}:${item.rank}`).join(",") === "A:1,C:2,D:2,B:3"));

  const rankingInvalid = await rankingRule({
    direction: "descending",
    items: [
      { id: "nan", value: numeric(Number.NaN) },
      { id: "infinity", value: numeric(Number.POSITIVE_INFINITY) },
      { id: "missing", value: null },
    ],
  });
  results.push(check("[Ranking3] NaN, Infinity, and missing values are rejected", rankingInvalid.status === "failed" && hasIssue(rankingInvalid, "MISSING_NUMERIC_VALUE") && hasIssue(rankingInvalid, "INVALID_NUMERIC_VALUE")));
  const rankingDirection = await rankingRule({ ...rankingInput, direction: "sideways" as "ascending" });
  results.push(check("[Ranking4] invalid sort direction is rejected at runtime", rankingDirection.status === "failed" && hasIssue(rankingDirection, "INVALID_RANKING_DIRECTION")));

  results.push(check("[Registry2] analysis trace is deterministic and no-LLM", cagr.trace.deterministic && !cagr.trace.llmUsed && cagr.status === "success"));

  const failingRegistry = new CortexRegistry();
  const failingRule: CortexRule<undefined, undefined> = {
    id: "calculation.test-throw", version: "1", category: "calculation", purpose: "Execution normalization test",
    execution: { deterministic: true, llmMode: "never" }, requirements: [], preconditions: () => [],
    execute: () => { throw new Error("expected calculation execution failure"); }, validate: () => [],
  };
  failingRegistry.register(failingRule);
  const normalizedFailure = await failingRegistry.execute("calculation.test-throw", undefined);
  results.push(check("[Registry3] execution exception becomes AnalysisResult failure", normalizedFailure.status === "failed" && hasIssue(normalizedFailure, "RULE_EXECUTION_FAILED")));

  return summarize("cortexCalculation", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (directFile === import.meta.url) {
  run().then(({ fail }) => {
    if (fail > 0) {
      process.exitCode = 1;
    }
  });
}
