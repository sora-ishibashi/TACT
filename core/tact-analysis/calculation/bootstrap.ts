import { CortexRegistry } from "../registry/CortexRegistry";
import { bootstrapCortexFoundation } from "../registry/bootstrap";
import type { CortexRule } from "../types";
import { cagrCalculationRule } from "./cagr";
import { growthRateCalculationRule } from "./growthRate";
import { percentageCalculationRule } from "./percentage";
import { rankingCalculationRule } from "./ranking";

export const calculationRules = [
  percentageCalculationRule,
  growthRateCalculationRule,
  cagrCalculationRule,
  rankingCalculationRule,
] as const;

export function registerCalculationRules(registry: CortexRegistry): CortexRegistry {
  for (const rule of calculationRules) {
    registry.register(rule as CortexRule);
  }

  return registry;
}

/** Explicit default composition for callers that want Foundation plus Phase 2A calculations. */
export function createDefaultCortexRegistry(): CortexRegistry {
  return registerCalculationRules(bootstrapCortexFoundation());
}
