import assert from "node:assert/strict";
import { summarizeActivityStatuses } from "../lib/statusPresentation";

assert.deepEqual(summarizeActivityStatuses([]), { failed: 0, running: 0, succeeded: 0 });
assert.deepEqual(summarizeActivityStatuses([
  { executionStatus: "failed" }, { executionStatus: "failed" }, { executionStatus: "running" },
  { executionStatus: "succeeded" }, { executionStatus: "succeeded" }, { executionStatus: "succeeded" },
  { executionStatus: "observed" }, { executionStatus: "cancelled" }, { executionStatus: "unknown" },
]), { failed: 2, running: 1, succeeded: 3 });
