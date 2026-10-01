import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLedgerJsonl, validateLedgerRecords } from "./validate-ledger";

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseLedgerJsonl(readFileSync(join(here, "synthetic-example.jsonl"), "utf8"));

if (parsed.issues.length > 0 || parsed.records.length === 0) {
  throw new Error("synthetic example could not be loaded for validator tests");
}

const validRecord = parsed.records[0] as Record<string, unknown>;
const unsupportedRecord = parsed.records[1] as Record<string, unknown>;

function copy(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record);
}

function hasIssue(records: readonly unknown[], code: string): boolean {
  return validateLedgerRecords(records).issues.some((issue) => issue.code === code);
}

const invalidTimestamp = copy(validRecord);
invalidTimestamp.occurredAt = "2026-10-01 01:00:00";

const invalidEnum = copy(validRecord);
invalidEnum.actorType = "ROBOT";

const forbiddenSensitiveField = copy(validRecord);
forbiddenSensitiveField.rawPrompt = "synthetic raw content that must not be stored";

const missingWorkUnknown = copy(validRecord);
missingWorkUnknown.eventId = "gt-test-missing-work";
missingWorkUnknown.sourceOperationId = "test-action-missing-work";
missingWorkUnknown.workAssignmentBasis = "UNKNOWN";
missingWorkUnknown.expectedWorkId = null;
missingWorkUnknown.expectedWorkTitle = null;

const tests: TestResult[] = [
  {
    name: "valid ledger -> PASS",
    passed: validateLedgerRecords(parsed.records).valid,
  },
  {
    name: "duplicate eventId -> FAIL",
    passed: hasIssue([validRecord, { ...copy(validRecord), sourceOperationId: "test-action-duplicate", eventId: validRecord.eventId }], "duplicate_event_id"),
  },
  {
    name: "invalid timestamp -> FAIL",
    passed: hasIssue([invalidTimestamp], "invalid_timestamp"),
  },
  {
    name: "invalid enum -> FAIL",
    passed: hasIssue([invalidEnum], "invalid_enum"),
  },
  {
    name: "forbidden sensitive field -> FAIL",
    passed: hasIssue([forbiddenSensitiveField], "forbidden_field"),
  },
  {
    name: "missing Work correctly UNKNOWN -> PASS",
    passed: validateLedgerRecords([missingWorkUnknown]).valid,
  },
  {
    name: "unsupported path -> PASS",
    passed: validateLedgerRecords([unsupportedRecord]).valid,
  },
];

for (const test of tests) {
  console.log(`${test.passed ? "PASS" : "FAIL"} ${test.name}${test.detail ? `: ${test.detail}` : ""}`);
}

const failed = tests.filter((test) => !test.passed).length;
console.log(`validator tests: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
