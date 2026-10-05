// =========================
// TACT Integration — Connection Projection Producer Regression (SOR-212)
// =========================
//
// 対象: core/tact-integration/connectionProjection.tsの
// sendConnectionProjectionSnapshotBestEffort()。実HTTP送信・実Supabase
// 接続は一切行わない(DI経由でlistConnectionsForUser/fetchImplを
// 差し替える、既存tests/tact/integration/connectionLifecycle.test.tsと
// 同じDIパターン)。

import {
  sendConnectionProjectionSnapshotBestEffort,
  type SendConnectionProjectionSnapshotDeps,
} from "../../../core/tact-integration/connectionProjection";
import type { Connection } from "../../../core/tact-integration/types";
import type { ConnectionProjectionSnapshotInput } from "@tact/execution-contract";
import { check, summarize, type CheckResult } from "../lib/check";

// A plain function call, not a conditional — sidesteps a TypeScript
// control-flow-narrowing quirk where a `let` variable only ever mutated
// inside an async closure (fetchImpl below) is still seen as its
// declaration-time literal type at later read sites in the enclosing
// scope, narrowing a `!== null` check's truthy branch to `never`.
function mustHaveCaptured<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`${label}: expected a captured value but got null`);
  }
  return value;
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: "user-1",
    service: "gmail",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_gmail_1",
    metadata: { providerStatusRaw: "ACTIVE", someSecret: "should-never-cross" },
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // canonical list全件map / providerConnectionRef excluded / metadata excluded
  // =========================
  await withEnv({ RUNS_PROJECTION_BASE_URL: "https://runs.example.com", RUNS_PROJECTION_INGESTION_TOKEN: "test-token" }, async () => {

    let capturedBody: ConnectionProjectionSnapshotInput | null = null;
    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;

    const deps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => [
        makeConnection({ id: "conn-1", status: "active" }),
        makeConnection({ id: "conn-2", status: "pending", service: "slack" }),
        makeConnection({ id: "conn-3", status: "revoked", service: "notion" }),
      ],
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch,
    };

    await sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, deps);

    const body = mustHaveCaptured<ConnectionProjectionSnapshotInput>(capturedBody, "[producer] fetchImpl capture");

    results.push(check(
      "[producer] canonical list全件がpayload.connectionsへmapされる(3件)",
      body.connections.length === 3
    ));

    results.push(check(
      "[producer] userId/snapshotAtが正しく設定される",
      body.userId === "user-1" && body.snapshotAt === "2027-02-01T00:00:00.000Z"
    ));

    results.push(check(
      "[producer] providerConnectionRefはpayloadのどの項目にも一切含まれない",
      !JSON.stringify(body).includes("ca_gmail_1") && !JSON.stringify(body).includes("providerConnectionRef")
    ));

    results.push(check(
      "[producer] metadata(およびその中のsecret)はpayloadに一切含まれない",
      !JSON.stringify(body).includes("someSecret") && !JSON.stringify(body).includes("metadata")
    ));

    results.push(check(
      "[producer] 各itemはexternalConnectionId/service/status/provider/createdAt/updatedAtのみ",
      body.connections.every((c) => Object.keys(c).sort().join(",") === "createdAt,externalConnectionId,provider,service,status,updatedAt")
    ));

    results.push(check(
      "[producer] endpointはRUNS_PROJECTION_BASE_URL + /api/tact/runs/ingest/connections",
      capturedUrl === "https://runs.example.com/api/tact/runs/ingest/connections"
    ));

    results.push(check(
      "[producer] Authorization headerはRUNS_PROJECTION_INGESTION_TOKENをBearerで使う",
      capturedAuth === "Bearer test-token"
    ));

  });

  // =========================
  // missing config does not throw canonical flow
  // =========================
  await withEnv({ RUNS_PROJECTION_BASE_URL: undefined, RUNS_PROJECTION_INGESTION_TOKEN: undefined }, async () => {

    let fetchCalled = false;
    let listCalled = false;

    const deps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => { listCalled = true; return []; },
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: (async () => { fetchCalled = true; return new Response("{}", { status: 200 }); }) as typeof fetch,
    };

    let threw = false;
    try {
      await sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, deps);
    } catch {
      threw = true;
    }

    results.push(check("[producer] missing config never throws", !threw));
    results.push(check("[producer] missing config never calls listConnectionsForUser (no unnecessary canonical read)", !listCalled));
    results.push(check("[producer] missing config never attempts a network call", !fetchCalled));

  });

  // =========================
  // endpoint failure does not change canonical operation result
  // =========================
  await withEnv({ RUNS_PROJECTION_BASE_URL: "https://runs.example.com", RUNS_PROJECTION_INGESTION_TOKEN: "test-token" }, async () => {

    const nonOkDeps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => [makeConnection()],
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: (async () => new Response(JSON.stringify({ success: false }), { status: 500 })) as typeof fetch,
    };

    let threwOnNonOk = false;
    try {
      await sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, nonOkDeps);
    } catch {
      threwOnNonOk = true;
    }
    results.push(check("[producer] a non-2xx ingestion response never throws (best-effort)", !threwOnNonOk));

    const networkErrorDeps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => [makeConnection()],
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    };

    let threwOnNetworkError = false;
    try {
      await sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, networkErrorDeps);
    } catch {
      threwOnNetworkError = true;
    }
    results.push(check("[producer] a network error on the ingestion call never throws (best-effort)", !threwOnNetworkError));

    const listErrorDeps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => { throw new Error("canonical read failed transiently"); },
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    };

    let threwOnListError = false;
    try {
      await sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, listErrorDeps);
    } catch {
      threwOnListError = true;
    }
    results.push(check("[producer] a listConnectionsForUser() failure never throws (best-effort)", !threwOnListError));

  });

  // =========================
  // fix#4: a bounded request timeout — the fetch must never be allowed to
  // hang indefinitely, and an abort/timeout must never throw out of
  // sendConnectionProjectionSnapshotBestEffort() (canonical operation
  // must remain unaffected).
  // =========================
  await withEnv({ RUNS_PROJECTION_BASE_URL: "https://runs.example.com", RUNS_PROJECTION_INGESTION_TOKEN: "test-token" }, async () => {

    let capturedSignal: AbortSignal | null = null;

    // Models real fetch's own abort contract: it never settles until the
    // passed-in AbortSignal fires, then rejects with an AbortError — this
    // is the shape a hung request + timeout actually takes in production,
    // without this test itself waiting out a real multi-second timer.
    const abortAwareDeps: SendConnectionProjectionSnapshotDeps = {
      listConnectionsForUser: async () => [makeConnection()],
      now: () => "2027-02-01T00:00:00.000Z",
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        capturedSignal = (init?.signal as AbortSignal | undefined) ?? null;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      }) as typeof fetch,
    };

    let threwOnAbort = false;
    const pending = sendConnectionProjectionSnapshotBestEffort({ userId: "user-1", accessToken: "token-1" }, abortAwareDeps)
      .catch(() => { threwOnAbort = true; });

    // listConnectionsForUser() is awaited before fetchImpl is called, so
    // capturedSignal is not set on this same microtask tick — yield once
    // to let the function reach its fetchImpl call before inspecting it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const signal = mustHaveCaptured<AbortSignal>(capturedSignal, "[fix#4] fetchImpl capture");
    results.push(check(
      "[producer] fetchImpl receives an AbortSignal (bounded-timeout wiring is present)",
      typeof signal.addEventListener === "function"
    ));

    // Trigger the bound timeout's abort path directly (same effect as the
    // internal timer firing) instead of waiting out the real timeout —
    // the call under test is what must never throw once that happens.
    signal.dispatchEvent(new Event("abort"));
    await pending;

    results.push(check("[producer] an aborted/timed-out request never throws (best-effort)", !threwOnAbort));

  });

  return summarize("integration/connectionProjectionProducer", results);

}
