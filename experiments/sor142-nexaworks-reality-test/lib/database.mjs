import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath as canonicalDatabasePath, fixturePath as canonicalFixturePath, runtimeDir, schemaPath } from "./paths.mjs";

const tableNames = [
  "companies",
  "departments",
  "employees",
  "customers",
  "works",
  "documents",
  "tasks",
  "conversation_fragments",
  "meetings",
  "expected_executions",
];

export function loadFixture(path = canonicalFixturePath) {
  const bytes = readFileSync(path);
  return {
    data: JSON.parse(bytes.toString("utf8")),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function assertCanonicalDatabasePath(path) {
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolve(canonicalDatabasePath)) {
    throw new Error("Refusing destructive reset outside the canonical SOR-142 SQLite path.");
  }
  if (dirname(resolvedPath) !== resolve(runtimeDir) || basename(resolvedPath) !== "nexaworks.sqlite") {
    throw new Error("Refusing destructive reset outside the SOR-142 runtime directory.");
  }
}

function insertRows(db, sql, rows, mapRow) {
  const statement = db.prepare(sql);
  for (const row of rows) statement.run(...mapRow(row));
}

export function createSeededDatabase(path, options = {}) {
  const { fixturePath = canonicalFixturePath, allowNonCanonicalPath = false } = options;
  if (!allowNonCanonicalPath) assertCanonicalDatabasePath(path);

  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);

  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(schemaPath, "utf8"));
    const { data: fixture, sha256 } = loadFixture(fixturePath);
    const companyId = fixture.company.id;

    db.exec("begin immediate");
    try {
      db.prepare("insert into runtime_metadata(key, value) values (?, ?)").run("fixture_version", fixture.fixture_version);
      db.prepare("insert into runtime_metadata(key, value) values (?, ?)").run("fixture_sha256", sha256);
      db.prepare("insert into runtime_metadata(key, value) values (?, ?)").run("data_classification", "synthetic-only");
      db.prepare("insert into runtime_metadata(key, value) values (?, ?)").run("execution_evidence", "expected-not-observed");
      db.prepare("insert into companies(id, name, slug) values (?, ?, ?)").run(companyId, fixture.company.name, fixture.company.slug);

      insertRows(db, "insert into departments(id, company_id, name) values (?, ?, ?)", fixture.departments, (row) => [row.id, companyId, row.name]);
      insertRows(db, "insert into employees(id, company_id, department_id, display_name, email, role) values (?, ?, ?, ?, ?, ?)", fixture.employees, (row) => [row.id, companyId, row.department_id, row.display_name, row.email, row.role]);
      insertRows(db, "insert into customers(id, company_id, name, contact_email, status) values (?, ?, ?, ?, ?)", fixture.customers, (row) => [row.id, companyId, row.name, row.contact_email, row.status]);
      insertRows(db, "insert into works(id, company_id, scenario, title, objective, status, owner_employee_id, customer_id) values (?, ?, ?, ?, ?, ?, ?, ?)", fixture.works, (row) => [row.id, companyId, row.scenario, row.title, row.objective, row.status, row.owner_employee_id, row.customer_id]);
      insertRows(db, "insert into documents(id, work_id, kind, title, body) values (?, ?, ?, ?, ?)", fixture.documents, (row) => [row.id, row.work_id, row.kind, row.title, row.body]);
      insertRows(db, "insert into tasks(id, work_id, description, status, sequence) values (?, ?, ?, ?, ?)", fixture.tasks, (row) => [row.id, row.work_id, row.description, row.status, row.sequence]);
      insertRows(db, "insert into conversation_fragments(id, work_id, channel_kind, speaker_employee_id, body, ordinal) values (?, ?, ?, ?, ?, ?)", fixture.conversation_fragments, (row) => [row.id, row.work_id, row.channel_kind, row.speaker_employee_id, row.body, row.ordinal]);
      insertRows(db, "insert into meetings(id, work_id, title, held_at, summary) values (?, ?, ?, ?, ?)", fixture.meetings, (row) => [row.id, row.work_id, row.title, row.held_at, row.summary]);
      insertRows(db, "insert into expected_executions(id, work_id, task_id, fixture_type, source_kind, correlation_mode, expected_outcome, attempt, retry_of, observed) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", fixture.expected_executions, (row) => [row.id, row.work_id, row.task_id, row.fixture_type, row.source_kind, row.correlation_mode, row.expected_outcome, row.attempt, row.retry_of, row.observed ? 1 : 0]);

      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    db.close();
  }
}
export function verifyDatabase(path) {
  if (!existsSync(path)) return { ok: false, errors: ["database_missing"], counts: {} };

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("pragma foreign_keys = on");
    const counts = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`select count(*) as count from ${table}`).get().count]));
    const errors = [];
    const minimums = { companies: 1, departments: 3, employees: 6, customers: 2, works: 3, documents: 3, tasks: 9, conversation_fragments: 3, meetings: 3, expected_executions: 5 };

    for (const [table, minimum] of Object.entries(minimums)) {
      if (counts[table] < minimum) errors.push(`${table}_below_${minimum}`);
    }

    const scenarios = db.prepare("select count(distinct scenario) as count from works").get().count;
    if (scenarios !== 3) errors.push("missing_work_scenario");

    const explicit = db.prepare("select count(*) as count from expected_executions where correlation_mode = 'explicit_work_id'").get().count;
    const missing = db.prepare("select count(*) as count from expected_executions where correlation_mode = 'missing_work_id'").get().count;
    const failures = db.prepare("select count(*) as count from expected_executions where expected_outcome = 'failure'").get().count;
    const retries = db.prepare("select count(*) as count from expected_executions where expected_outcome = 'retry_success' and retry_of is not null").get().count;
    const observed = db.prepare("select count(*) as count from expected_executions where observed <> 0").get().count;
    if (explicit < 1) errors.push("explicit_work_id_case_missing");
    if (missing < 1) errors.push("missing_work_id_case_missing");
    if (failures < 1) errors.push("failure_case_missing");
    if (retries < 1) errors.push("retry_case_missing");
    if (observed !== 0) errors.push("fixture_claims_observation");

    const foreignKeyFailures = db.prepare("pragma foreign_key_check").all();
    if (foreignKeyFailures.length > 0) errors.push("foreign_key_check_failed");

    const fixtureVersion = db.prepare("select value from runtime_metadata where key = 'fixture_version'").get()?.value;
    const fixtureSha256 = db.prepare("select value from runtime_metadata where key = 'fixture_sha256'").get()?.value;
    const expectedFixture = loadFixture();
    if (fixtureVersion !== expectedFixture.data.fixture_version) errors.push("fixture_version_mismatch");
    if (fixtureSha256 !== expectedFixture.sha256) errors.push("fixture_sha256_mismatch");

    return { ok: errors.length === 0, errors, counts, fixtureVersion, fixtureSha256 };
  } finally {
    db.close();
  }
}
