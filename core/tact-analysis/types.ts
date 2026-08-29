// Cortex Foundation v1
//
// Cortex is application behaviour: it never stores rules in Core Memory or
// Knowledge, and it never writes Artifact blocks directly.  These contracts
// keep evidence, semantic analysis, and presentation separate.

export type CortexRuleCategory =
  | "data"
  | "calculation"
  | "framework"
  | "reasoning"
  | "validation"
  | "presentation";

export type LlmMode = "never" | "plan" | "extract" | "interpret";

export type EvidenceRequirementKind =
  | "numeric"
  | "categorical"
  | "temporal"
  | "entity"
  | "text";

export interface EvidenceRequirement {
  id: string;
  kind: EvidenceRequirementKind;
  description: string;
  required: boolean;
  minimumCount?: number;
}

export type ValidationSeverity = "info" | "warning" | "error";

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  evidenceIds?: string[];
  path?: string;
}

export interface CortexRule<Input = unknown, Output = unknown> {
  /** Stable, namespaced application identifier, for example `validation/source-coverage`. */
  id: string;
  version: string;
  category: CortexRuleCategory;
  purpose: string;
  execution: {
    deterministic: boolean;
    /** Metadata only in Foundation v1. The registry never invokes an LLM. */
    llmMode: LlmMode;
  };
  requirements: EvidenceRequirement[];
  preconditions(input: Input): ValidationIssue[];
  execute(input: Input): Promise<Output> | Output;
  validate(output: Output, input: Input): ValidationIssue[];
}

export interface AnalysisStep {
  id: string;
  ruleId: string;
  ruleVersion: string;
  dependsOn: string[];
  reason: string;
  parameters?: Record<string, unknown>;
}

export interface AnalysisPlan {
  id: string;
  objective: string;
  steps: AnalysisStep[];
  missingRequirements: EvidenceRequirement[];
  createdBy: "deterministic" | "llm" | "hybrid";
}

export interface AnalysisTrace {
  startedAt: string;
  completedAt: string;
  deterministic: boolean;
  /** Always false in Foundation v1: no LLM executor is provided by the registry. */
  llmUsed: boolean;
  inputIds: string[];
}

export interface AnalysisResult<Output = unknown> {
  id: string;
  rule: {
    id: string;
    version: string;
  };
  status: "success" | "partial" | "failed";
  output?: Output;
  sourceEvidenceIds: string[];
  warnings: ValidationIssue[];
  trace: AnalysisTrace;
}

export type DatasetColumnType =
  | "string"
  | "number"
  | "date"
  | "percentage"
  | "currency"
  | "boolean";

export interface ColumnDefinition {
  id: string;
  label: string;
  type: DatasetColumnType;
  unit?: string;
}

export type DatasetScalar = string | number | boolean | null;

export interface DatasetValue {
  raw: DatasetScalar;
  normalized?: DatasetScalar;
  sourceEvidenceIds: string[];
}

export interface DatasetRow {
  id: string;
  values: Record<string, DatasetValue>;
  sourceEvidenceIds: string[];
}

export interface Dataset {
  id: string;
  columns: ColumnDefinition[];
  rows: DatasetRow[];
  sourceEvidenceIds: string[];
}

export type TimeGranularity = "year" | "month";

export type TimePeriod =
  | {
      kind: "point";
      raw: string;
      start: string;
      granularity: TimeGranularity;
    }
  | {
      kind: "range";
      raw: string;
      start: string;
      end: string;
      granularity: TimeGranularity;
    };

export interface NumericValue {
  raw: string;
  value: number;
  unit?: string;
  currency?: string;
  period?: TimePeriod;
  precision?: number;
  sourceEvidenceIds: string[];
}
