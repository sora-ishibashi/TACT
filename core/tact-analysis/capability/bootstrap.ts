import { analysisCapabilities } from "./evaluate";
import { AnalysisCapabilityRegistry } from "./registry";

/** Explicit composition avoids a global mutable capability registry. */
export function createDefaultAnalysisCapabilityRegistry(): AnalysisCapabilityRegistry {
  const registry = new AnalysisCapabilityRegistry();
  for (const capability of analysisCapabilities) registry.register(capability);
  return registry;
}
