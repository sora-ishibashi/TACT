import { createDefaultCortexRegistry } from "../calculation/bootstrap";
import type { CortexRule } from "../types";
import { pestRule, swotRule, threeCRule } from "./rules";
export const frameworkRules = [swotRule, threeCRule, pestRule] as const;
export function createFrameworkCortexRegistry() { const registry = createDefaultCortexRegistry(); for (const rule of frameworkRules) registry.register(rule as CortexRule); return registry; }
