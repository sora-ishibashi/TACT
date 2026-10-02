import { loadFixture } from "../sor142-nexaworks-reality-test/lib/database.mjs";
import { buildGroundTruthLedger } from "../sor142-nexaworks-reality-test/ground-truth.mjs";
import { validateLedgerRecords } from "./validate-ledger";

const { data } = loadFixture();
const result = validateLedgerRecords(buildGroundTruthLedger(data));
const retry = result.valid && buildGroundTruthLedger(data).find((record) => record.attemptNumber === 2);
const passed = result.valid && result.recordCount === data.expected_executions.length && retry?.retryGroupId !== null;
console.log(`${passed ? "PASS" : "FAIL"} SOR-142 fixture mapping validates as independent SOR-143 ground truth`);
if (!passed) {
  for (const issue of result.issues) console.error(`${issue.path} [${issue.code}] ${issue.message}`);
  process.exitCode = 1;
}
