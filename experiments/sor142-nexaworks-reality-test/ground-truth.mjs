import { readFileSync } from "node:fs";
import { fixturePath } from "./lib/paths.mjs";
const FIXTURE_EPOCH = "2026-10-01T00:00:00.000Z";
function resultFor(expectedOutcome) { return expectedOutcome === "failure" ? "FAILED" : "SUCCEEDED"; }
/** Converts expected synthetic fixture operations into SOR-143 ledger rows. */
export function buildGroundTruthLedger(fixture) {
  const worksById = new Map(fixture.works.map((work) => [work.id, work]));
  const employeesById = new Map(fixture.employees.map((employee) => [employee.id, employee]));
  return fixture.expected_executions.map((expected, index) => {
    const work = expected.work_id ? worksById.get(expected.work_id) : undefined;
    const owner = work ? employeesById.get(work.owner_employee_id) : undefined;
    const hasWork = Boolean(work && owner);
    const occurredAt = new Date(Date.parse(FIXTURE_EPOCH) + index * 60_000).toISOString();
    return { schemaVersion: 1, scenarioId: hasWork ? `nexaworks-${work.scenario}` : "nexaworks-unassigned", sourceOperationId: expected.id, eventId: `sor142-ground-truth-${expected.id}`, occurredAt, recordedAt: occurredAt, timezone: "UTC", actorType: "AI", actorId: hasWork ? owner.id : "nexaworks-fixture-agent", responsibleHuman: hasWork ? owner.id : null, tool: expected.source_kind, provider: "nexaworks-fixture", targetType: "synthetic_execution", targetId: expected.id, actionCategory: "EXECUTE", actionSummary: `Synthetic ${expected.source_kind} expected ${expected.expected_outcome}`, actualResult: resultFor(expected.expected_outcome), expectedWorkId: hasWork ? work.id : null, expectedWorkTitle: hasWork ? work.title : null, workAssignmentBasis: hasWork ? "DETERMINISTIC" : "UNKNOWN", intentionalTest: true, naturalWork: false, retryGroupId: expected.retry_of ?? null, attemptNumber: expected.attempt,
      // Expected data has not traversed a Runs observation path.
      expectedObservationStatus: "UNSUPPORTED", captureGapExpectation: "UNSUPPORTED", comparisonTimingWindowSeconds: 0, expectedPermissionStatus: "NOT_EVALUATED", expectedOutcomeStatus: "UNKNOWN", evidenceType: "DETERMINISTIC_FIXTURE", evidenceRef: `fixture://sor142/${expected.id}`, evidenceConfidence: "HIGH", delegationParentEventId: null, attributionRevisionOfEventId: null, notes: "Derived from the isolated SOR-142 expectation fixture; not a Runs observation." };
  });
}
export function loadFixtureGroundTruth() { return buildGroundTruthLedger(JSON.parse(readFileSync(fixturePath, "utf8"))); }
