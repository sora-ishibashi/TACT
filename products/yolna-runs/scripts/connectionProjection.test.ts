// =========================
// Yolna Runs Standalone — Connection Projection Regression (SOR-212)
// =========================
//
// No real Supabase connection — the adapter's real code
// (postgresConnectionProjectionAdapter.ts) is exercised against a minimal
// in-memory fake Supabase client (same "deps injection + fake client"
// pattern as tests/tact/execution/permission/registryStore.test.ts at
// root), and the ingestion route's real exported POST handler is called
// directly with constructed Request objects. Nothing here applies a
// migration or touches a real database — the migration SQL itself is only
// verified at the source-text level (see
// tests/tact/integration/connectionProjectionContract.test.ts at root for
// that and for the shared contract's forbidden-field check).

import assert from "node:assert/strict";
import { getServiceRoleClient } from "@tact/runs-core/database/supabaseServiceRole";
import {
  createPostgresConnectionProjectionRepository,
  createPostgresConnectionProjectionWriter,
  postgresConnectionProjectionWriter,
} from "../lib/projection/postgresConnectionProjectionAdapter";

// Derived via the exact same import graph the adapter itself uses — a
// locally re-imported `SupabaseClient` from "@supabase/supabase-js" can
// resolve to a different (structurally-near-identical but nominally
// distinct, due to protected members) package instance under npm's
// hoisting, which TypeScript then correctly refuses to unify. Deriving
// `Client` this way sidesteps that entirely.
type Client = NonNullable<ReturnType<typeof getServiceRoleClient>>;
import {
  validateConnectionProjectionSnapshotInput,
} from "../lib/projection/ingestionValidation";
import { verifyIngestionRequest } from "../lib/projection/ingestionAuth";
import { POST as ingestConnectionsPOST } from "../app/api/tact/runs/ingest/connections/route";
import type { NextRequest } from "next/server";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

// =========================
// In-memory fake Supabase client (state table + projection table + the
// one RPC the writer calls) — models the migration's own semantics
// (full delete+reinsert, state advanced only after all items succeed).
// =========================

interface FakeStateRow { user_id: string; last_snapshot_at: string; projected_at: string }
interface FakeProjectionRow {
  external_connection_id: string; user_id: string; service: string; status: string;
  provider: string; source_created_at: string; source_updated_at: string; projected_at: string;
}

function makeFakeClient(initial: { stateRows?: FakeStateRow[]; projectionRows?: FakeProjectionRow[] } = {}) {

  const stateRows = new Map<string, FakeStateRow>((initial.stateRows ?? []).map((r) => [r.user_id, { ...r }]));
  let projectionRows: FakeProjectionRow[] = (initial.projectionRows ?? []).map((r) => ({ ...r }));

  function queryBuilder(table: string) {

    const filters: Array<[string, unknown]> = [];

    function matching(): Record<string, unknown>[] {
      const source: Record<string, unknown>[] =
        table === "tact_runs_connection_projection_state"
          ? ([...stateRows.values()] as unknown as Record<string, unknown>[])
          : (projectionRows as unknown as Record<string, unknown>[]);
      return source.filter((row) => filters.every(([col, val]) => row[col] === val));
    }

    const builder: {
      select: (cols: string) => typeof builder;
      eq: (col: string, val: unknown) => typeof builder;
      maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: null }>;
      then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => void) => void;
    } = {
      select: () => builder,
      eq: (col, val) => { filters.push([col, val]); return builder; },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (resolve) => resolve({ data: matching(), error: null }),
    };

    return builder;

  }

  const client = {

    from(table: string) {
      return { select: (cols: string) => queryBuilder(table).select(cols) };
    },

    async rpc(name: string, params: Record<string, unknown>) {

      if (name !== "replace_tact_runs_connection_projection_snapshot") {
        return { data: null, error: { message: `unsupported rpc ${name}` } };
      }

      const userId = params.p_user_id as string;
      const snapshotAt = params.p_snapshot_at as string;
      const connections = params.p_connections as Array<Record<string, unknown>>;

      if (!Array.isArray(connections)) {
        return { data: null, error: { message: "p_connections must be a JSON array" } };
      }

      for (const item of connections) {
        if (!item.externalConnectionId || !item.service || !item.status || !item.provider || !item.createdAt || !item.updatedAt) {
          return { data: null, error: { message: "connection item missing a required field" } };
        }
      }

      // Same ordering as the migration: delete + reinsert, THEN advance
      // state — modeling the "fail-closed, not fail-forward" guarantee.
      projectionRows = projectionRows.filter((row) => row.user_id !== userId);

      for (const item of connections) {
        projectionRows.push({
          external_connection_id: item.externalConnectionId as string,
          user_id: userId,
          service: item.service as string,
          status: item.status as string,
          provider: item.provider as string,
          source_created_at: item.createdAt as string,
          source_updated_at: item.updatedAt as string,
          projected_at: new Date().toISOString(),
        });
      }

      stateRows.set(userId, { user_id: userId, last_snapshot_at: snapshotAt, projected_at: new Date().toISOString() });

      return { data: { outcome: "replaced", count: connections.length }, error: null };

    },

  };

  return client as unknown as Client;

}

async function run(): Promise<void> {

  // =========================
  // projection: no state row -> unavailable
  // =========================
  {
    const client = makeFakeClient();
    const repo = createPostgresConnectionProjectionRepository({ getClient: () => client });
    const state = await repo.getSnapshotState("user-a");
    check("[projection] no state row -> readState=unavailable", state.readState === "unavailable" && state.lastSnapshotAt === null);
  }

  // =========================
  // projection: initialized snapshot + zero rows -> available + []
  // =========================
  {
    const client = makeFakeClient();
    const writer = createPostgresConnectionProjectionWriter({ getClient: () => client });
    const repo = createPostgresConnectionProjectionRepository({ getClient: () => client });

    await writer.replaceSnapshot({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [] });

    const state = await repo.getSnapshotState("user-a");
    const items = await repo.listConnectionsForUser("user-a");

    check("[projection] empty snapshot still creates a state row -> available", state.readState === "available" && state.lastSnapshotAt === "2027-01-01T00:00:00.000Z");
    check("[projection] empty snapshot -> listConnectionsForUser returns []", Array.isArray(items) && items.length === 0);
  }

  // =========================
  // projection: active/pending/revoked複数保持 + same id status update
  // =========================
  {
    const client = makeFakeClient();
    const writer = createPostgresConnectionProjectionWriter({ getClient: () => client });
    const repo = createPostgresConnectionProjectionRepository({ getClient: () => client });

    await writer.replaceSnapshot({
      userId: "user-a",
      snapshotAt: "2027-01-01T00:00:00.000Z",
      connections: [
        { externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
        { externalConnectionId: "conn-2", service: "slack", status: "pending", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
        { externalConnectionId: "conn-3", service: "notion", status: "revoked", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
      ],
    });

    const items = await repo.listConnectionsForUser("user-a");
    check("[projection] active/pending/revoked all persist in one snapshot", items.length === 3 &&
      items.some((i) => i.externalConnectionId === "conn-1" && i.status === "active") &&
      items.some((i) => i.externalConnectionId === "conn-2" && i.status === "pending") &&
      items.some((i) => i.externalConnectionId === "conn-3" && i.status === "revoked"));

    // same id, status update via a second full snapshot.
    await writer.replaceSnapshot({
      userId: "user-a",
      snapshotAt: "2027-01-02T00:00:00.000Z",
      connections: [
        { externalConnectionId: "conn-1", service: "gmail", status: "revoked", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-02T00:00:00.000Z" },
      ],
    });

    const itemsAfter = await repo.listConnectionsForUser("user-a");
    check("[projection] a later full snapshot fully replaces the prior one (same id, new status, old siblings gone)",
      itemsAfter.length === 1 && itemsAfter[0].externalConnectionId === "conn-1" && itemsAfter[0].status === "revoked");
  }

  // =========================
  // projection: tenant A cannot read tenant B
  // =========================
  {
    const client = makeFakeClient();
    const writer = createPostgresConnectionProjectionWriter({ getClient: () => client });
    const repo = createPostgresConnectionProjectionRepository({ getClient: () => client });

    await writer.replaceSnapshot({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [
      { externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
    ] });
    await writer.replaceSnapshot({ userId: "user-b", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [] });

    const bState = await repo.getSnapshotState("user-b");
    const bItems = await repo.listConnectionsForUser("user-b");
    const aItems = await repo.listConnectionsForUser("user-a");

    check("[projection] tenant B's own (empty) snapshot is available and does not see tenant A's rows", bState.readState === "available" && bItems.length === 0);
    check("[projection] tenant A's rows are not visible to tenant B's read, and vice versa", aItems.length === 1 && aItems[0].externalConnectionId === "conn-1");
  }

  // =========================
  // projection: full snapshot state updated only after successful snapshot
  // =========================
  {
    const client = makeFakeClient();
    const writer = createPostgresConnectionProjectionWriter({ getClient: () => client });
    const repo = createPostgresConnectionProjectionRepository({ getClient: () => client });

    // A first, valid snapshot succeeds.
    await writer.replaceSnapshot({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [
      { externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
    ] });

    // A second attempt is malformed (missing a required field) and the
    // fake RPC reports an error — the real writer must throw, not swallow it.
    let threw = false;
    try {
      await writer.replaceSnapshot({ userId: "user-a", snapshotAt: "2027-01-02T00:00:00.000Z", connections: [
        { externalConnectionId: "conn-2" } as never,
      ] });
    } catch {
      threw = true;
    }

    const state = await repo.getSnapshotState("user-a");
    const items = await repo.listConnectionsForUser("user-a");

    check("[projection] a failed snapshot attempt throws", threw);
    check("[projection] a failed snapshot attempt never advances lastSnapshotAt", state.lastSnapshotAt === "2027-01-01T00:00:00.000Z");
    check("[projection] a failed snapshot attempt leaves the previous successful snapshot's rows intact", items.length === 1 && items[0].externalConnectionId === "conn-1");
  }

  // =========================
  // ingestion: validation (pure)
  // =========================
  {
    const valid = validateConnectionProjectionSnapshotInput({
      userId: "user-a",
      snapshotAt: "2027-01-01T00:00:00.000Z",
      connections: [
        { externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
      ],
    });
    check("[ingestion validation] a well-formed snapshot is accepted", valid.ok === true);

    const emptyOk = validateConnectionProjectionSnapshotInput({
      userId: "user-a",
      snapshotAt: "2027-01-01T00:00:00.000Z",
      connections: [],
    });
    check("[ingestion validation] an empty connections array is accepted", emptyOk.ok === true && emptyOk.value?.connections.length === 0);

    const malformed = validateConnectionProjectionSnapshotInput("not an object");
    check("[ingestion validation] a non-object body is rejected", malformed.ok === false);

    const missingFields = validateConnectionProjectionSnapshotInput({ userId: "user-a" });
    check("[ingestion validation] a body missing snapshotAt/connections is rejected", missingFields.ok === false);

    const badStatus = validateConnectionProjectionSnapshotInput({
      userId: "user-a",
      snapshotAt: "2027-01-01T00:00:00.000Z",
      connections: [
        { externalConnectionId: "conn-1", service: "gmail", status: "not_a_real_status", provider: "composio", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z" },
      ],
    });
    check("[ingestion validation] an unrecognized status value is rejected", badStatus.ok === false);

    const withForbiddenFields = validateConnectionProjectionSnapshotInput({
      userId: "user-a",
      snapshotAt: "2027-01-01T00:00:00.000Z",
      connections: [
        {
          externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio",
          createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z",
          providerConnectionRef: "ca_should_be_dropped", metadata: { token: "should_be_dropped" },
        },
      ],
    });
    check(
      "[ingestion validation] unknown/forbidden fields on an otherwise-valid item never reach the validated value (allowlist extraction)",
      withForbiddenFields.ok === true &&
      Object.keys(withForbiddenFields.value!.connections[0]).sort().join(",") ===
        "createdAt,externalConnectionId,provider,service,status,updatedAt"
    );
  }

  // =========================
  // ingestion: auth (pure, verifyIngestionRequest reused as-is)
  // =========================
  {
    const originalToken = process.env.RUNS_PROJECTION_INGESTION_TOKEN;

    try {

      delete process.env.RUNS_PROJECTION_INGESTION_TOKEN;
      const noTokenConfigured = verifyIngestionRequest(new Request("http://localhost/x", { headers: { authorization: "Bearer anything" } }));
      check("[ingestion auth] token not configured -> fail closed (unauthorized)", noTokenConfigured.authorized === false && noTokenConfigured.reason === "token_not_configured");

      process.env.RUNS_PROJECTION_INGESTION_TOKEN = "correct-token";

      const missingHeader = verifyIngestionRequest(new Request("http://localhost/x"));
      check("[ingestion auth] missing Authorization header -> unauthorized", missingHeader.authorized === false && missingHeader.reason === "missing_authorization_header");

      const wrongToken = verifyIngestionRequest(new Request("http://localhost/x", { headers: { authorization: "Bearer wrong-token" } }));
      check("[ingestion auth] wrong token -> unauthorized", wrongToken.authorized === false && wrongToken.reason === "token_mismatch");

      const rightToken = verifyIngestionRequest(new Request("http://localhost/x", { headers: { authorization: "Bearer correct-token" } }));
      check("[ingestion auth] correct token -> authorized", rightToken.authorized === true);

    } finally {
      if (originalToken === undefined) {
        delete process.env.RUNS_PROJECTION_INGESTION_TOKEN;
      } else {
        process.env.RUNS_PROJECTION_INGESTION_TOKEN = originalToken;
      }
    }

  }

  // =========================
  // ingestion: route wiring (real exported POST handler, writer monkey-patched
  // to avoid a real DB connection)
  // =========================
  {

    const originalToken = process.env.RUNS_PROJECTION_INGESTION_TOKEN;
    const originalReplaceSnapshot = postgresConnectionProjectionWriter.replaceSnapshot;

    process.env.RUNS_PROJECTION_INGESTION_TOKEN = "route-test-token";

    function makeRequest(body: unknown, headers: Record<string, string> = { authorization: "Bearer route-test-token" }): NextRequest {
      return new Request("http://localhost/api/tact/runs/ingest/connections", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }) as unknown as NextRequest;
    }

    try {

      // token未設定
      delete process.env.RUNS_PROJECTION_INGESTION_TOKEN;
      let writerCalled = false;
      postgresConnectionProjectionWriter.replaceSnapshot = async () => { writerCalled = true; };
      const noTokenResponse = await ingestConnectionsPOST(makeRequest({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [] }));
      check("[ingestion route] token not configured -> 401, writer never called", noTokenResponse.status === 401 && !writerCalled);

      process.env.RUNS_PROJECTION_INGESTION_TOKEN = "route-test-token";

      // wrong token
      writerCalled = false;
      const wrongTokenResponse = await ingestConnectionsPOST(makeRequest({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [] }, { authorization: "Bearer not-the-token" }));
      check("[ingestion route] wrong token -> 401, writer never called", wrongTokenResponse.status === 401 && !writerCalled);

      // malformed JSON body
      writerCalled = false;
      const malformedRequest = new Request("http://localhost/api/tact/runs/ingest/connections", {
        method: "POST",
        headers: { authorization: "Bearer route-test-token", "content-type": "application/json" },
        body: "{not json",
      }) as unknown as NextRequest;
      const malformedResponse = await ingestConnectionsPOST(malformedRequest);
      check("[ingestion route] malformed JSON body -> 400, writer never called", malformedResponse.status === 400 && !writerCalled);

      // invalid payload (missing required field)
      writerCalled = false;
      const invalidResponse = await ingestConnectionsPOST(makeRequest({ userId: "user-a" }));
      check("[ingestion route] invalid payload -> 400, writer never called", invalidResponse.status === 400 && !writerCalled);

      // valid snapshot, with forbidden fields present on the wire — must
      // accept, and the writer must receive only the allowlisted shape.
      let capturedInput: unknown = null;
      postgresConnectionProjectionWriter.replaceSnapshot = async (input) => { capturedInput = input; };

      const validResponse = await ingestConnectionsPOST(makeRequest({
        userId: "user-a",
        snapshotAt: "2027-01-01T00:00:00.000Z",
        connections: [
          {
            externalConnectionId: "conn-1", service: "gmail", status: "active", provider: "composio",
            createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z",
            providerConnectionRef: "ca_should_never_reach_writer", metadata: { secret: "nope" }, token: "nope",
          },
        ],
      }));
      const validBody = await validResponse.json();

      check("[ingestion route] a well-formed snapshot (with extra forbidden wire fields) is accepted", validResponse.status === 200 && validBody.success === true);
      check(
        "[ingestion route] unknown/forbidden wire fields never reach the writer",
        capturedInput !== null &&
        Object.keys((capturedInput as { connections: Array<Record<string, unknown>> }).connections[0]).sort().join(",") ===
          "createdAt,externalConnectionId,provider,service,status,updatedAt"
      );

      // empty connections snapshot accept, end-to-end through the route.
      let emptyCaptured: unknown = null;
      postgresConnectionProjectionWriter.replaceSnapshot = async (input) => { emptyCaptured = input; };
      const emptyResponse = await ingestConnectionsPOST(makeRequest({ userId: "user-a", snapshotAt: "2027-01-01T00:00:00.000Z", connections: [] }));
      const emptyBody = await emptyResponse.json();
      check(
        "[ingestion route] an empty connections snapshot is accepted end-to-end",
        emptyResponse.status === 200 && emptyBody.success === true &&
        (emptyCaptured as { connections: unknown[] } | null)?.connections.length === 0
      );

    } finally {
      postgresConnectionProjectionWriter.replaceSnapshot = originalReplaceSnapshot;
      if (originalToken === undefined) {
        delete process.env.RUNS_PROJECTION_INGESTION_TOKEN;
      } else {
        process.env.RUNS_PROJECTION_INGESTION_TOKEN = originalToken;
      }
    }

  }

  console.log(`CONNECTION_PROJECTION_TESTS=${checks.length}/${checks.length}`);

}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
