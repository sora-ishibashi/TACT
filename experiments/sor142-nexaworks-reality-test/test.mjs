import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSeededDatabase, loadFixture, verifyDatabase } from "./lib/database.mjs";
import { assertParentEnvironmentSafe, assertRuntimeEnvironmentIsIsolated, buildIsolatedRuntimeEnvironment, parsePort } from "./lib/guards.mjs";
import { buildGroundTruthLedger } from "./ground-truth.mjs";

test("fixture seeds deterministic, internally consistent local data", () => {
  const directory = mkdtempSync(join(tmpdir(), "sor142-nexaworks-"));
  const database = join(directory, "test.sqlite");
  try {
    createSeededDatabase(database, { allowNonCanonicalPath: true });
    const first = verifyDatabase(database);
    assert.equal(first.ok, true, first.errors.join(", "));
    assert.equal(first.counts.employees, 6);
    assert.equal(first.counts.customers, 3);
    assert.equal(first.counts.works, 4);

    createSeededDatabase(database, { allowNonCanonicalPath: true });
    const second = verifyDatabase(database);
    assert.deepEqual(second.counts, first.counts);
    assert.equal(second.fixtureSha256, first.fixtureSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixture provides stable expected cases without claiming observation", () => {
  const { data } = loadFixture();
  assert.equal(data.fixture_kind, "expected_reality_test_data");
  assert.equal(data.observed_execution_count, 0);
  assert.ok(data.expected_executions.every((item) => item.fixture_type === "fixture_expectation" && item.observed === false));
  assert.ok(data.expected_executions.some((item) => item.correlation_mode === "explicit_work_id"));
  assert.ok(data.expected_executions.some((item) => item.correlation_mode === "missing_work_id"));
  assert.ok(data.expected_executions.some((item) => item.expected_outcome === "failure"));
  assert.ok(data.expected_executions.some((item) => item.expected_outcome === "retry_success" && item.retry_of));
  assert.deepEqual(new Set(data.works.map((work) => work.scenario)), new Set(["sales", "product", "operations"]));
});

test("fixture maps to a valid independent SOR-143 ledger without claiming Runs observation", () => {
  const { data } = loadFixture();
  const records = buildGroundTruthLedger(data);
  assert.equal(records.length, data.expected_executions.length);
  assert.ok(records.every((record) => record.expectedObservationStatus === "UNSUPPORTED"));
  assert.ok(records.every((record) => record.captureGapExpectation === "UNSUPPORTED"));
  assert.ok(records.some((record) => record.workAssignmentBasis === "UNKNOWN" && record.expectedWorkId === null));
  assert.ok(records.some((record) => record.attemptNumber === 2 && record.retryGroupId !== null));
});

test("cloud and staging targets fail closed", () => {
  assert.throws(() => assertParentEnvironmentSafe({ VERCEL_ENV: "production" }), /not a local environment/);
  assert.throws(() => assertParentEnvironmentSafe({ NEXT_PUBLIC_SUPABASE_URL: "https://hosted.supabase.co" }), /not loopback/);
  assert.throws(() => assertParentEnvironmentSafe({ SUPABASE_PROJECT_REF: "staging-ref" }), /non-local project/);
  assert.doesNotThrow(() => assertParentEnvironmentSafe({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }));
});

test("runtime environment allowlist drops credentials", () => {
  const isolated = buildIsolatedRuntimeEnvironment({
    PATH: "synthetic-path",
    COMPOSIO_API_KEY: "must-not-cross-boundary",
    SLACK_BOT_TOKEN: "must-not-cross-boundary",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-cross-boundary",
  }, 43142);
  assert.equal(isolated.COMPOSIO_API_KEY, undefined);
  assert.equal(isolated.SLACK_BOT_TOKEN, undefined);
  assert.equal(isolated.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.doesNotThrow(() => assertRuntimeEnvironmentIsIsolated(isolated));
});

test("runtime port is local-test bounded", () => {
  assert.equal(parsePort(undefined), 43142);
  assert.equal(parsePort("53142"), 53142);
  assert.throws(() => parsePort("443"), /between 1024 and 65535/);
});
