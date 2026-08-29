import type { AnalysisCapability, AnalysisCapabilityKind, AnalysisPurpose, CapabilityEvaluation, CapabilityEvaluationInput } from "./types";

const KIND_ORDER: Record<AnalysisCapabilityKind, number> = {
  calculation: 0,
  presentation: 1,
  framework: 2,
};

/** Instance-based descriptive registry. It never selects or executes a Cortex Rule. */
export class AnalysisCapabilityRegistry {
  private readonly capabilities = new Map<string, AnalysisCapability>();

  register(capability: AnalysisCapability): this {
    const existing = this.capabilities.get(capability.id);
    if (existing) {
      throw new Error(`Duplicate Cortex capability registration: ${capability.id}@${capability.version} (already ${existing.version})`);
    }
    this.capabilities.set(capability.id, capability);
    return this;
  }

  get(id: string): AnalysisCapability | undefined {
    return this.capabilities.get(id);
  }

  list(): AnalysisCapability[] {
    return [...this.capabilities.values()].sort((left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version),
    );
  }

  findByPurpose(purpose: AnalysisPurpose): AnalysisCapability[] {
    return this.list().filter((capability) => capability.purposes.includes(purpose));
  }

  evaluate(id: string, input: CapabilityEvaluationInput): CapabilityEvaluation | undefined {
    return this.get(id)?.evaluate(input);
  }

  evaluateAll(input: CapabilityEvaluationInput): CapabilityEvaluation[] {
    return this.list().map((capability) => capability.evaluate(input));
  }
}
