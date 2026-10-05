import assert from "node:assert/strict";
import { summarizeActivityStatuses } from "../lib/statusPresentation";
import { workStatusPresentation } from "../lib/workStatusPresentation";

assert.deepEqual(summarizeActivityStatuses([]), { failed: 0, running: 0, succeeded: 0 });
assert.deepEqual(summarizeActivityStatuses([
  { executionStatus: "failed" }, { executionStatus: "failed" }, { executionStatus: "running" },
  { executionStatus: "succeeded" }, { executionStatus: "succeeded" }, { executionStatus: "succeeded" },
  { executionStatus: "observed" }, { executionStatus: "cancelled" }, { executionStatus: "unknown" },
]), { failed: 2, running: 1, succeeded: 3 });
assert.deepEqual([
  "created", "planning", "running", "waiting_for_input", "waiting_for_approval", "completed", "failed", "cancelled",
].map(workStatusPresentation), ["作成済み", "計画中", "進行中", "入力待ち", "承認待ち", "完了", "失敗", "取消済み"]);
assert.equal(workStatusPresentation("unrecognized_status"), "unrecognized_status");
