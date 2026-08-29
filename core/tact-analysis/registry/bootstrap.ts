import { CortexRegistry } from "./CortexRegistry";
import type { CortexRule } from "../types";

/**
 * Explicit composition root for Cortex. Foundation v1 intentionally registers
 * no implicit/global rules; callers may pass the rules enabled for their use case.
 */
export function bootstrapCortexFoundation(rules: readonly CortexRule[] = []): CortexRegistry {
  const registry = new CortexRegistry();

  for (const rule of rules) {
    registry.register(rule);
  }

  return registry;
}
