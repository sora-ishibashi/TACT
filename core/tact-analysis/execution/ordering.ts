import type { AnalysisPlanStep } from "../planner/types";

/** Deterministic topological order; malformed cycles are intentionally surfaced to the executor. */
export function orderAnalysisSteps(steps: readonly AnalysisPlanStep[]): { ordered: AnalysisPlanStep[]; cyclicStepIds: string[]; unknownDependencies: Map<string, string[]> } {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const unknownDependencies = new Map<string, string[]>();
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  const children = new Map<string, string[]>();
  for (const step of steps) for (const dependency of step.dependsOn) {
    if (!byId.has(dependency)) { unknownDependencies.set(step.id, [...(unknownDependencies.get(step.id) ?? []), dependency]); continue; }
    indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    children.set(dependency, [...(children.get(dependency) ?? []), step.id]);
  }
  const ready = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).sort((a, b) => a.id.localeCompare(b.id));
  const ordered: AnalysisPlanStep[] = [];
  while (ready.length) {
    const step = ready.shift()!; ordered.push(step);
    for (const childId of children.get(step.id) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1; indegree.set(childId, next);
      if (next === 0) { ready.push(byId.get(childId)!); ready.sort((a, b) => a.id.localeCompare(b.id)); }
    }
  }
  return { ordered, cyclicStepIds: steps.filter((step) => !ordered.some((item) => item.id === step.id)).map((step) => step.id), unknownDependencies };
}
