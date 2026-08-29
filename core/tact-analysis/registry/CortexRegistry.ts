import {
  type AnalysisResult,
  type CortexRuleCategory,
  type CortexRule,
  type EvidenceRequirement,
  type LlmMode,
  type ValidationIssue,
} from "../types";

export interface CortexRuleExecutionOptions {
  version?: string;
  inputIds?: string[];
  sourceEvidenceIds?: string[];
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => id.trim().length > 0))];
}

function issue(
  code: string,
  severity: ValidationIssue["severity"],
  message: string
): ValidationIssue {
  return { code, severity, message };
}

function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === "error");
}

function hasWarnings(issues: readonly ValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === "warning");
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const issue = value as Partial<ValidationIssue>;
  return typeof issue.code === "string" &&
    typeof issue.message === "string" &&
    ["info", "warning", "error"].includes(issue.severity ?? "");
}

function validationIssues(value: unknown, invalidCode: string): ValidationIssue[] {
  if (!Array.isArray(value) || !value.every(isValidationIssue)) {
    return [issue(invalidCode, "error", "CortexRule validator must return ValidationIssue[]")];
  }
  return value;
}

function outputEvidenceIds(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as { sourceEvidenceIds?: unknown };
  return Array.isArray(candidate.sourceEvidenceIds)
    ? candidate.sourceEvidenceIds.filter((id): id is string => typeof id === "string")
    : [];
}

const CATEGORIES = new Set<CortexRuleCategory>([
  "data", "calculation", "framework", "reasoning", "validation", "presentation",
]);
const LLM_MODES = new Set<LlmMode>(["never", "plan", "extract", "interpret"]);

function isEvidenceRequirement(value: unknown): value is EvidenceRequirement {
  if (!value || typeof value !== "object") {
    return false;
  }
  const requirement = value as Partial<EvidenceRequirement>;
  return typeof requirement.id === "string" &&
    typeof requirement.description === "string" &&
    typeof requirement.required === "boolean" &&
    ["numeric", "categorical", "temporal", "entity", "text"].includes(requirement.kind ?? "") &&
    (requirement.minimumCount === undefined ||
      (typeof requirement.minimumCount === "number" && Number.isInteger(requirement.minimumCount) && requirement.minimumCount >= 0));
}

/** Minimal runtime guard for rules received across a JavaScript/module boundary. */
export function isCortexRule(value: unknown): value is CortexRule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const rule = value as Partial<CortexRule>;
  return typeof rule.id === "string" &&
    typeof rule.version === "string" &&
    typeof rule.purpose === "string" &&
    CATEGORIES.has(rule.category as CortexRuleCategory) &&
    Boolean(rule.execution) &&
    typeof rule.execution?.deterministic === "boolean" &&
    LLM_MODES.has(rule.execution?.llmMode as LlmMode) &&
    Array.isArray(rule.requirements) && rule.requirements.every(isEvidenceRequirement) &&
    typeof rule.preconditions === "function" &&
    typeof rule.execute === "function" &&
    typeof rule.validate === "function";
}

/**
 * A deterministic rule executor. It has no global state and deliberately has
 * no LLM dependency; callers create one registry per composition root or test.
 */
export class CortexRegistry {
  private readonly rulesById = new Map<string, Map<string, CortexRule>>();

  register<Input, Output>(rule: CortexRule<Input, Output>): void {
    if (!isCortexRule(rule) || !rule.id.trim() || !rule.version.trim()) {
      throw new Error("CortexRule id and version are required");
    }

    const versions = this.rulesById.get(rule.id) ?? new Map<string, CortexRule>();

    if (versions.has(rule.version)) {
      throw new Error(`CortexRule already registered: ${rule.id}@${rule.version}`);
    }

    versions.set(rule.version, rule as CortexRule);
    this.rulesById.set(rule.id, versions);
  }

  get(id: string, version?: string): CortexRule | undefined {
    const versions = this.rulesById.get(id);

    if (!versions) {
      return undefined;
    }

    if (version) {
      return versions.get(version);
    }

    // A rule version is part of the execution contract. Do not silently choose
    // one when a caller has not supplied it and several versions are present.
    return versions.size === 1 ? versions.values().next().value : undefined;
  }

  list(): CortexRule[] {
    return [...this.rulesById.entries()]
      .flatMap(([, versions]) => [...versions.values()])
      .sort((left, right) => {
        const byId = left.id.localeCompare(right.id);
        return byId !== 0 ? byId : left.version.localeCompare(right.version);
      });
  }

  async execute<Input, Output>(
    id: string,
    input: Input,
    options: CortexRuleExecutionOptions = {}
  ): Promise<AnalysisResult<Output>> {
    const startedAt = new Date().toISOString();
    const rule = this.get(id, options.version) as CortexRule<Input, Output> | undefined;
    const inputIds = uniqueIds(options.inputIds);
    const sourceEvidenceIds = uniqueIds(options.sourceEvidenceIds);

    if (!rule) {
      return this.failedResult<Output>(
        id,
        options.version ?? "unresolved",
        [issue("RULE_NOT_FOUND", "error", `No CortexRule registered for ${id}${options.version ? `@${options.version}` : ""}`)],
        startedAt,
        inputIds,
        sourceEvidenceIds
      );
    }

    let preconditionIssues: ValidationIssue[];

    try {
      preconditionIssues = validationIssues(rule.preconditions(input), "INVALID_PRECONDITION_RESULT");
    } catch (error) {
      return this.failedResult<Output>(
        rule.id,
        rule.version,
        [issue("RULE_PRECONDITION_FAILED", "error", this.errorMessage(error))],
        startedAt,
        inputIds,
        sourceEvidenceIds,
        rule.execution.deterministic
      );
    }

    if (hasErrors(preconditionIssues)) {
      return this.failedResult<Output>(
        rule.id,
        rule.version,
        preconditionIssues,
        startedAt,
        inputIds,
        sourceEvidenceIds,
        rule.execution.deterministic
      );
    }

    let output: Output;

    try {
      output = await rule.execute(input);
    } catch (error) {
      return this.failedResult<Output>(
        rule.id,
        rule.version,
        [...preconditionIssues, issue("RULE_EXECUTION_FAILED", "error", this.errorMessage(error))],
        startedAt,
        inputIds,
        sourceEvidenceIds,
        rule.execution.deterministic
      );
    }

    let postValidationIssues: ValidationIssue[];

    try {
      postValidationIssues = validationIssues(rule.validate(output, input), "INVALID_POST_VALIDATION_RESULT");
    } catch (error) {
      postValidationIssues = [issue("RULE_POST_VALIDATION_FAILED", "error", this.errorMessage(error))];
    }

    const warnings = [...preconditionIssues, ...postValidationIssues];

    return {
      id: crypto.randomUUID(),
      rule: { id: rule.id, version: rule.version },
      status: hasErrors(warnings) || hasWarnings(warnings) ? "partial" : "success",
      output,
      sourceEvidenceIds: uniqueIds([...sourceEvidenceIds, ...outputEvidenceIds(output)]),
      warnings,
      trace: {
        startedAt,
        completedAt: new Date().toISOString(),
        deterministic: rule.execution.deterministic,
        llmUsed: false,
        inputIds,
      },
    };
  }

  private failedResult<Output>(
    id: string,
    version: string,
    warnings: ValidationIssue[],
    startedAt: string,
    inputIds: string[],
    sourceEvidenceIds: string[],
    deterministic = true
  ): AnalysisResult<Output> {
    return {
      id: crypto.randomUUID(),
      rule: { id, version },
      status: "failed",
      sourceEvidenceIds,
      warnings,
      trace: {
        startedAt,
        completedAt: new Date().toISOString(),
        deterministic,
        llmUsed: false,
        inputIds,
      },
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown CortexRule execution failure";
  }
}
