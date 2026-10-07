// =========================
// SOR-260 Phase 1 — Principal Registry store regression
// =========================
//
// Exercises resolveOrCreateExternalPrincipal() against a fake Supabase
// client (same convention as tests/tact/execution/governance/
// approvalRequestStore.test.ts — no real Supabase/DB connection). Covers:
// external-only creation, duplicate-race read-back ("resolved"), the
// reserved 'runs-local-auth' namespace rejection, invalid-input rejection,
// unavailable-client fail-closed, and non-leakage of raw DB error detail.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOrCreateExternalPrincipal,
  RESERVED_LOCAL_AUTH_NAMESPACE,
  type PrincipalStoreDeps,
} from "@tact/runs-core/tact-execution/principal/store";
import { check, summarize, type CheckResult } from "../../lib/check";

// Sequential fake client: each `.single()`/`.maybeSingle()` call consumes
// the next entry from `singleResults`, in call order — identical shape to
// approvalRequestStore.test.ts's own makeSequentialFakeClient().
function makeSequentialFakeClient(singleResults: Array<{ data: unknown; error: unknown }>) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: () => builder,
    select: () => builder,
    eq: () => builder,
    single: async () => singleResults[callIndex++],
    maybeSingle: async () => singleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

function principalRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "principal-1",
    namespace: "yolna-root-staging",
    external_subject_id: "yolna-user-42",
    local_auth_user_id: null,
    principal_kind: "external_subject",
    created_at: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- fresh create: external principal, never local_runs_user ----
  {
    const row = principalRowFixture();
    const deps: PrincipalStoreDeps = { getClient: () => makeSequentialFakeClient([{ data: row, error: null }]) };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("fresh resolve: status created", outcome.status === "created"));
    results.push(check(
      "fresh resolve: principal_kind is external_subject, localAuthUserId is null",
      outcome.status === "created" && outcome.principal.principalKind === "external_subject" && outcome.principal.localAuthUserId === null
    ));
    results.push(check(
      "fresh resolve: namespace/externalSubjectId round-trip",
      outcome.status === "created" && outcome.principal.namespace === "yolna-root-staging" && outcome.principal.externalSubjectId === "yolna-user-42"
    ));
  }

  // ---- repeat resolve (23505 race) returns the SAME principal, read back by natural key ----
  {
    const existingRow = principalRowFixture({ id: "principal-1" });
    const client = makeSequentialFakeClient([
      { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"tact_runs_principals_namespace_external_subject_id_key\"" } },
      { data: existingRow, error: null },
    ]);
    const deps: PrincipalStoreDeps = { getClient: () => client };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("23505 race: status resolved (not created, not error)", outcome.status === "resolved"));
    results.push(check(
      "23505 race: reads back the WINNER's row by (namespace, external_subject_id)",
      outcome.status === "resolved" && outcome.principal.id === "principal-1"
    ));
  }

  // ---- [negative] 23505 winner is an incompatible local_runs_user row: fail closed, never "resolved" ----
  {
    // Constructed to be unreachable in practice (a local_runs_user row's
    // own CHECK constraint pins its namespace to 'runs-local-auth' and its
    // external_subject_id to its own id, so it could never actually share
    // a natural key with an external-subject request) — this test proves
    // the application-level guard itself, independent of whether the DB
    // schema also happens to prevent the scenario.
    const incompatibleRow = principalRowFixture({
      id: "principal-should-never-be-returned",
      principal_kind: "local_runs_user",
      local_auth_user_id: "principal-should-never-be-returned",
    });
    const client = makeSequentialFakeClient([
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: incompatibleRow, error: null },
    ]);
    const deps: PrincipalStoreDeps = { getClient: () => client };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("[negative] incompatible local_runs_user winner: never status=resolved", outcome.status !== "resolved"));
    results.push(check("[negative] incompatible local_runs_user winner: fails closed as unavailable", outcome.status === "unavailable"));
  }

  // ---- [negative] 23505 winner has a non-null local_auth_user_id despite claiming external_subject: fail closed ----
  {
    const incompatibleRow = principalRowFixture({
      id: "principal-should-never-be-returned-2",
      principal_kind: "external_subject",
      local_auth_user_id: "some-auth-user-id",
    });
    const client = makeSequentialFakeClient([
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: incompatibleRow, error: null },
    ]);
    const deps: PrincipalStoreDeps = { getClient: () => client };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("[negative] incompatible non-null local_auth_user_id winner: never status=resolved", outcome.status !== "resolved"));
    results.push(check("[negative] incompatible non-null local_auth_user_id winner: fails closed as unavailable", outcome.status === "unavailable"));
  }

  // ---- [negative] fresh insert returning a mismatched row is also rejected, not just the 23505 path ----
  {
    const mismatchedRow = principalRowFixture({
      id: "principal-mismatched-fresh-insert",
      namespace: "a-different-namespace-than-requested",
    });
    const deps: PrincipalStoreDeps = { getClient: () => makeSequentialFakeClient([{ data: mismatchedRow, error: null }]) };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("[negative] mismatched fresh-insert row: never status=created", outcome.status !== "created"));
    results.push(check("[negative] mismatched fresh-insert row: fails closed as unavailable", outcome.status === "unavailable"));
  }

  // ---- repeat resolve is idempotent at the natural-key level: two calls, same principal.id ----
  {
    const row = principalRowFixture({ id: "principal-stable", external_subject_id: "yolna-user-stable" });
    const firstDeps: PrincipalStoreDeps = { getClient: () => makeSequentialFakeClient([{ data: row, error: null }]) };
    const secondDeps: PrincipalStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: { code: "23505", message: "duplicate key" } },
        { data: row, error: null },
      ]),
    };

    const first = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-stable", firstDeps);
    const second = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-stable", secondDeps);

    results.push(check(
      "repeat resolve: same (namespace, externalSubjectId) yields the same principal.id across calls",
      first.status !== "invalid" && first.status !== "unavailable" &&
      second.status !== "invalid" && second.status !== "unavailable" &&
      "principal" in first && "principal" in second &&
      first.principal.id === second.principal.id
    ));
  }

  // ---- reserved namespace rejected before any DB call ----
  {
    const deps: PrincipalStoreDeps = { getClient: () => { throw new Error("must not be called for a reserved-namespace attempt"); } };

    const outcome = await resolveOrCreateExternalPrincipal(RESERVED_LOCAL_AUTH_NAMESPACE, "someone", deps);

    results.push(check("reserved namespace: rejected as invalid, never reaches the client", outcome.status === "invalid"));
    results.push(check(
      "reserved namespace: error message names the reserved namespace",
      outcome.status === "invalid" && outcome.errors.some((e) => e.includes(RESERVED_LOCAL_AUTH_NAMESPACE))
    ));
  }

  // ---- invalid inputs fail cleanly, before any DB call ----
  {
    const deps: PrincipalStoreDeps = { getClient: () => { throw new Error("must not be called for invalid input"); } };

    const blankNamespace = await resolveOrCreateExternalPrincipal("", "subject-1", deps);
    results.push(check("blank namespace: invalid, never reaches the client", blankNamespace.status === "invalid"));

    const whitespaceNamespace = await resolveOrCreateExternalPrincipal("   ", "subject-1", deps);
    results.push(check("whitespace-only namespace: invalid, never reaches the client", whitespaceNamespace.status === "invalid"));

    const blankSubject = await resolveOrCreateExternalPrincipal("yolna-root-staging", "", deps);
    results.push(check("blank externalSubjectId: invalid, never reaches the client", blankSubject.status === "invalid"));

    const tooLongNamespace = await resolveOrCreateExternalPrincipal("x".repeat(256), "subject-1", deps);
    results.push(check("namespace over 255 chars: invalid, never reaches the client", tooLongNamespace.status === "invalid"));

    const tooLongSubject = await resolveOrCreateExternalPrincipal("yolna-root-staging", "x".repeat(256), deps);
    results.push(check("externalSubjectId over 255 chars: invalid, never reaches the client", tooLongSubject.status === "invalid"));
  }

  // ---- service role unavailable fails closed ----
  {
    const deps: PrincipalStoreDeps = { getClient: () => null };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("getClient() returns null: unavailable, fail-closed", outcome.status === "unavailable"));
  }

  // ---- non-23505 DB failure never leaks raw Postgres error detail ----
  {
    const sensitiveMessage = "insert or update on table \"tact_runs_principals\" violates foreign key constraint — connection string postgres://service_role:SECRET@db.internal:5432/postgres";
    const deps: PrincipalStoreDeps = {
      getClient: () => makeSequentialFakeClient([{ data: null, error: { code: "23503", message: sensitiveMessage } }]),
    };

    const outcome = await resolveOrCreateExternalPrincipal("yolna-root-staging", "yolna-user-42", deps);

    results.push(check("non-duplicate DB failure: fails closed as unavailable", outcome.status === "unavailable"));
    results.push(check(
      "non-duplicate DB failure: outcome carries no message field at all (no raw Postgres detail to leak)",
      !("message" in outcome)
    ));
  }

  return summarize("SOR-260 Phase 1 — Principal Registry store regression", results);

}
