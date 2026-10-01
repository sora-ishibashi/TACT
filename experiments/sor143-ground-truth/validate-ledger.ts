import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface LedgerValidationIssue {
  line: number;
  path: string;
  code: string;
  message: string;
}

export interface LedgerValidationResult {
  valid: boolean;
  recordCount: number;
  issues: LedgerValidationIssue[];
}

export interface ParsedLedger {
  records: unknown[];
  issues: LedgerValidationIssue[];
}

const REQUIRED_FIELDS = [
  "schemaVersion",
  "scenarioId",
  "sourceOperationId",
  "eventId",
  "occurredAt",
  "recordedAt",
  "timezone",
  "actorType",
  "actorId",
  "responsibleHuman",
  "tool",
  "provider",
  "targetType",
  "targetId",
  "actionCategory",
  "actionSummary",
  "actualResult",
  "expectedWorkId",
  "expectedWorkTitle",
  "workAssignmentBasis",
  "intentionalTest",
  "naturalWork",
  "retryGroupId",
  "attemptNumber",
  "expectedObservationStatus",
  "captureGapExpectation",
  "comparisonTimingWindowSeconds",
  "expectedPermissionStatus",
  "expectedOutcomeStatus",
  "evidenceType",
  "evidenceRef",
  "evidenceConfidence",
  "delegationParentEventId",
  "attributionRevisionOfEventId",
  "notes",
] as const;

const OPTIONAL_FIELDS = ["sourceLocalTime", "sourceTimezone"] as const;
const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

const ACTOR_TYPES = ["HUMAN", "AI", "SYSTEM"] as const;
const ACTION_CATEGORIES = ["READ", "CREATE", "UPDATE", "SEND", "DELETE", "SHARE", "EXECUTE", "APPROVE", "UNKNOWN"] as const;
const ACTUAL_RESULTS = ["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"] as const;
const WORK_BASES = ["EXPLICIT", "DETERMINISTIC", "HUMAN_CONFIRMED", "UNKNOWN"] as const;
const OBSERVATION_STATUSES = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"] as const;
const CAPTURE_EXPECTATIONS = ["EXPECTED_VISIBLE", "PARTIALLY_VISIBLE", "UNSUPPORTED", "SUSPECTED_OUTAGE"] as const;
const PERMISSION_STATUSES = ["ALLOWED", "DENIED", "APPROVAL_REQUIRED", "UNKNOWN", "NOT_EVALUATED"] as const;
const OUTCOME_STATUSES = ["ASSERTED", "UNKNOWN"] as const;
const EVIDENCE_TYPES = ["API_HISTORY", "GIT_HISTORY", "CLI_HISTORY", "DETERMINISTIC_FIXTURE", "HUMAN_IMMEDIATE", "HUMAN_RETROSPECTIVE", "OTHER"] as const;
const EVIDENCE_CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;

const FORBIDDEN_FIELD_NAMES = new Set([
  "prompt",
  "prompttext",
  "rawprompt",
  "body",
  "rawbody",
  "payload",
  "rawpayload",
  "message",
  "messagetext",
  "slacktext",
  "emailbody",
  "documentbody",
  "documentcontent",
  "password",
  "passphrase",
  "oauthtoken",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "clientsecret",
  "authorization",
  "authorizationheader",
  "credential",
  "credentials",
  "secret",
  "thirdpartypersonaldata",
  "personaldata",
]);

const SECRET_VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "authorization bearer value", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { name: "Slack token", pattern: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}/ },
  { name: "GitHub token", pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}/ },
  { name: "API token", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
];

const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFieldName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function addIssue(
  issues: LedgerValidationIssue[],
  line: number,
  path: string,
  code: string,
  message: string
): void {
  issues.push({ line, path, code, message });
}

function scanForbiddenContent(
  value: unknown,
  line: number,
  path: string,
  issues: LedgerValidationIssue[]
): void {
  if (typeof value === "string") {
    for (const candidate of SECRET_VALUE_PATTERNS) {
      if (candidate.pattern.test(value)) {
        addIssue(issues, line, path, "secret_like_value", `${candidate.name} is forbidden`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenContent(entry, line, `${path}[${index}]`, issues));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELD_NAMES.has(normalizeFieldName(key))) {
      addIssue(issues, line, entryPath, "forbidden_field", "sensitive or raw-content field is forbidden");
    }
    scanForbiddenContent(entry, line, entryPath, issues);
  }
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  line: number,
  issues: LedgerValidationIssue[],
  maxLength?: number
): void {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, line, key, "invalid_string", "must be a non-empty string");
  } else if (maxLength !== undefined && value.length > maxLength) {
    addIssue(issues, line, key, "string_too_long", `must be at most ${maxLength} characters`);
  }
}

function requireNullableString(
  record: Record<string, unknown>,
  key: string,
  line: number,
  issues: LedgerValidationIssue[]
): void {
  const value = record[key];
  if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
    addIssue(issues, line, key, "invalid_nullable_string", "must be null or a non-empty string");
  }
}

function requireEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  line: number,
  issues: LedgerValidationIssue[]
): void {
  if (typeof record[key] !== "string" || !allowed.includes(record[key] as string)) {
    addIssue(issues, line, key, "invalid_enum", `must be one of ${allowed.join(", ")}`);
  }
}

function requireUtcTimestamp(
  record: Record<string, unknown>,
  key: string,
  line: number,
  issues: LedgerValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    addIssue(issues, line, key, "invalid_timestamp", "must be a valid UTC ISO-8601 timestamp ending in Z");
  }
}

function validateRecord(record: unknown, line: number): LedgerValidationIssue[] {
  const issues: LedgerValidationIssue[] = [];
  scanForbiddenContent(record, line, "", issues);

  if (!isRecord(record)) {
    addIssue(issues, line, "$", "invalid_record", "each JSONL line must contain one object");
    return issues;
  }

  for (const key of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      addIssue(issues, line, key, "missing_required", "required field is missing");
    }
  }

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      addIssue(issues, line, key, "unknown_field", "field is not part of ledger schema v1");
    }
  }

  if (record.schemaVersion !== 1) {
    addIssue(issues, line, "schemaVersion", "invalid_schema_version", "must equal 1");
  }

  for (const key of ["scenarioId", "sourceOperationId", "eventId", "actorId", "tool", "provider", "targetType", "targetId"] as const) {
    requireNonEmptyString(record, key, line, issues);
  }
  requireNonEmptyString(record, "actionSummary", line, issues, 240);
  requireNonEmptyString(record, "evidenceRef", line, issues, 500);

  for (const key of ["responsibleHuman", "expectedWorkId", "expectedWorkTitle", "retryGroupId", "delegationParentEventId", "attributionRevisionOfEventId"] as const) {
    requireNullableString(record, key, line, issues);
  }

  requireUtcTimestamp(record, "occurredAt", line, issues);
  requireUtcTimestamp(record, "recordedAt", line, issues);
  if (record.timezone !== "UTC") {
    addIssue(issues, line, "timezone", "invalid_timezone", "stored ledger timestamps must use timezone UTC");
  }

  const hasSourceLocalTime = Object.prototype.hasOwnProperty.call(record, "sourceLocalTime");
  const hasSourceTimezone = Object.prototype.hasOwnProperty.call(record, "sourceTimezone");
  if (hasSourceLocalTime !== hasSourceTimezone) {
    addIssue(issues, line, "sourceLocalTime", "unpaired_source_time", "sourceLocalTime and sourceTimezone must be supplied together");
  }
  if (hasSourceLocalTime) {
    requireNonEmptyString(record, "sourceLocalTime", line, issues);
    requireNonEmptyString(record, "sourceTimezone", line, issues);
  }

  requireEnum(record, "actorType", ACTOR_TYPES, line, issues);
  requireEnum(record, "actionCategory", ACTION_CATEGORIES, line, issues);
  requireEnum(record, "actualResult", ACTUAL_RESULTS, line, issues);
  requireEnum(record, "workAssignmentBasis", WORK_BASES, line, issues);
  requireEnum(record, "expectedObservationStatus", OBSERVATION_STATUSES, line, issues);
  requireEnum(record, "captureGapExpectation", CAPTURE_EXPECTATIONS, line, issues);
  requireEnum(record, "expectedPermissionStatus", PERMISSION_STATUSES, line, issues);
  requireEnum(record, "expectedOutcomeStatus", OUTCOME_STATUSES, line, issues);
  requireEnum(record, "evidenceType", EVIDENCE_TYPES, line, issues);
  requireEnum(record, "evidenceConfidence", EVIDENCE_CONFIDENCES, line, issues);

  for (const key of ["intentionalTest", "naturalWork"] as const) {
    if (typeof record[key] !== "boolean") {
      addIssue(issues, line, key, "invalid_boolean", "must be boolean");
    }
  }

  if (!Number.isInteger(record.attemptNumber) || (record.attemptNumber as number) < 1) {
    addIssue(issues, line, "attemptNumber", "invalid_attempt", "must be an integer greater than or equal to 1");
  }
  if (!Number.isInteger(record.comparisonTimingWindowSeconds) || (record.comparisonTimingWindowSeconds as number) < 0 || (record.comparisonTimingWindowSeconds as number) > 86400) {
    addIssue(issues, line, "comparisonTimingWindowSeconds", "invalid_timing_window", "must be an integer from 0 through 86400");
  }

  if (record.workAssignmentBasis === "UNKNOWN" && (record.expectedWorkId !== null || record.expectedWorkTitle !== null)) {
    addIssue(issues, line, "expectedWorkId", "unknown_work_must_be_null", "UNKNOWN Work basis requires null Work ID and title");
  }
  if (record.workAssignmentBasis !== "UNKNOWN" && record.expectedWorkId === null) {
    addIssue(issues, line, "expectedWorkId", "attributed_work_requires_id", "evidence-backed Work attribution requires a Work ID");
  }
  if ((record.attemptNumber as number) > 1 && record.retryGroupId === null) {
    addIssue(issues, line, "retryGroupId", "retry_group_required", "attemptNumber greater than 1 requires retryGroupId");
  }
  if (record.delegationParentEventId === record.eventId) {
    addIssue(issues, line, "delegationParentEventId", "self_reference", "an event cannot delegate to itself");
  }
  if (record.attributionRevisionOfEventId === record.eventId) {
    addIssue(issues, line, "attributionRevisionOfEventId", "self_reference", "an attribution revision cannot reference itself");
  }

  if (typeof record.notes !== "string" || record.notes.length > 500) {
    addIssue(issues, line, "notes", "invalid_notes", "must be a string of at most 500 characters");
  }

  return issues;
}

export function parseLedgerJsonl(text: string): ParsedLedger {
  const records: unknown[] = [];
  const issues: LedgerValidationIssue[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index].trim();
    if (!source) {
      continue;
    }
    try {
      records.push(JSON.parse(source) as unknown);
    } catch {
      addIssue(issues, index + 1, "$", "invalid_json", "line is not valid JSON");
    }
  }

  return { records, issues };
}

export function validateLedgerRecords(records: readonly unknown[]): LedgerValidationResult {
  const issues = records.flatMap((record, index) => validateRecord(record, index + 1));
  const seenEventIds = new Map<string, number>();
  const seenSourceOperationIds = new Map<string, number>();

  records.forEach((record, index) => {
    if (!isRecord(record)) {
      return;
    }
    for (const [field, seen, code] of [
      ["eventId", seenEventIds, "duplicate_event_id"],
      ["sourceOperationId", seenSourceOperationIds, "duplicate_source_operation_id"],
    ] as const) {
      const value = record[field];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const firstLine = seen.get(value);
      if (firstLine !== undefined) {
        addIssue(issues, index + 1, field, code, `duplicates line ${firstLine}`);
      } else {
        seen.set(value, index + 1);
      }
    }
  });

  return { valid: issues.length === 0, recordCount: records.length, issues };
}

export function validateLedgerJsonl(text: string): LedgerValidationResult {
  const parsed = parseLedgerJsonl(text);
  const validated = validateLedgerRecords(parsed.records);
  const issues = [...parsed.issues, ...validated.issues];
  return { valid: issues.length === 0, recordCount: parsed.records.length, issues };
}

function main(): void {
  const ledgerPath = process.argv[2];
  if (!ledgerPath) {
    console.error("Usage: npx tsx experiments/sor143-ground-truth/validate-ledger.ts <ledger.jsonl>");
    process.exitCode = 2;
    return;
  }

  let text: string;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    console.error(`FAIL unable to read ledger: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const result = validateLedgerJsonl(text);
  if (result.valid) {
    console.log(`PASS ${result.recordCount} ledger event(s) validated`);
    return;
  }

  console.error(`FAIL ${result.issues.length} validation issue(s) across ${result.recordCount} parsed event(s)`);
  for (const issue of result.issues) {
    console.error(`line ${issue.line} ${issue.path} [${issue.code}] ${issue.message}`);
  }
  process.exitCode = 1;
}

if (basename(process.argv[1] ?? "") === "validate-ledger.ts") {
  main();
}
