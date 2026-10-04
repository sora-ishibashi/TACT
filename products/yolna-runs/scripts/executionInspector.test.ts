import assert from "node:assert/strict";
import { toExecutionInspectorViewModel } from "../lib/executionInspector";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution";

const execution = {
  id: "execution-1", actorKind: "ai_agent", actorId: "requester-1", agentId: "agent-1",
  provider: "notion", targetProvider: null, adapterVersion: null, operation: "notion_update_page",
  resourceType: "page", resourceIdentifier: "Roadmap", providerOccurredAt: "2026-01-02T03:04:05.000Z",
  observedAt: "2026-01-02T03:05:05.000Z", status: "succeeded", outcomeStatus: null, outcomeKind: null,
  workId: null, permissionStatus: "pending", permissionReasonCode: null, observationMode: "INSTRUMENTED",
  sourceType: "webhook", sourceMetadata: { invocationId: "invoke-1" }, rawPayloadRef: "obs-1",
} as unknown as CanonicalExecution;

const model = toExecutionInspectorViewModel(execution, [], []);
assert.equal(model.summary.action, "UPDATE_PAGE");
assert.equal(model.summary.occurredAt, "2026-01-02T03:04:05.000Z");
assert.equal(model.summary.observedAt, "2026-01-02T03:05:05.000Z");
assert.equal(model.permission.registered, "Unknown");
assert.equal(model.technical.invocationId, "invoke-1");
assert.equal(model.permission.downstream.length, 0);
console.log("PASS execution inspector projection");
