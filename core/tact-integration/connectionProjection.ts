// =========================
// TACT Integration — Connection Projection Producer (SOR-212)
// =========================
//
// The ONLY place in root Yolna that sends a Connection snapshot to Runs
// (@tact/execution-contract's ConnectionProjectionSnapshotInput, over
// POST /api/tact/runs/ingest/connections). This is deliberately separate
// from provider adapters, core/tact-integration/connection.ts's store
// functions, the Composio adapter, and ConnectionProvisioningProvider
// implementations (section 10 absolute condition) — those own canonical
// Connection semantics and must stay ignorant of Runs' existence. Only the
// three API routes that already call a canonical provisioning operation
// (app/api/tact/connections/route.ts, [connectionId]/confirm/route.ts,
// disconnect/route.ts) call this file, AFTER that operation has already
// succeeded.
//
// Absolute condition (best-effort, secondary system): nothing in this file
// may ever cause a canonical Connection create/confirm/disconnect to fail
// or roll back. Every failure mode here — missing config, a
// listConnectionsForUser() error, a network error, a non-2xx response —
// is caught, logged (fixed message only; the configured URL/token value
// itself is never logged), and swallowed. Callers do not need to (and
// must not) wrap this in their own try/catch for that reason — this
// function never throws.
//
// Full snapshot, not an event: every call reads the CURRENT complete list
// of this user's Connections (listConnectionsForUser(), same canonical
// source of truth app/api/tact/connections/route.ts's own GET uses) and
// sends all of it — never just the single Connection a particular
// create/confirm/disconnect call happened to touch. This is required, not
// optional: refreshIntegrationConnectionStatus() can trigger
// finalizeConnectionReplacement() to revoke a sibling Connection as a
// side effect of THIS user's confirm, and that sibling's new "revoked"
// status must reach the snapshot in the same breath as the newly active
// one — see app/api/tact/connections/[connectionId]/confirm/route.ts's
// own call site comment.
//
// Data minimization (absolute condition, same as
// @tact/execution-contract's Connection Projection Contract this file
// builds payloads against): providerConnectionRef and metadata are read
// from each Connection row by listConnectionsForUser() but never touched
// by toConnectionProjectionItem() below — only
// id/service/status/provider/createdAt/updatedAt cross into the payload.

import { listConnectionsForUser as defaultListConnectionsForUser } from "./connection";
import type { Connection } from "./types";
import type { ConnectionProjectionItem, ConnectionProjectionSnapshotInput } from "@tact/execution-contract";

export interface SendConnectionProjectionSnapshotParams {

  userId: string;

  accessToken: string;

}

export interface SendConnectionProjectionSnapshotDeps {

  listConnectionsForUser: typeof defaultListConnectionsForUser;

  fetchImpl: typeof fetch;

  now: () => string;

}

const defaultDeps: SendConnectionProjectionSnapshotDeps = {
  listConnectionsForUser: defaultListConnectionsForUser,
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => new Date().toISOString(),
};

// SOR-212(fix#4、絶対条件): "projection failureはcanonical operationへ
// 影響してはならない"——このfetchがhangするとcanonical操作(POST
// /connections・/confirm・/disconnect)自体のHTTP responseがtimeoutし
// てしまい、既に成功しているcanonical mutationの結果が呼び出し元に
// 返らなくなる。bounded timeoutでそれを構造的に防ぐ(新しいenvは
// 追加しない、固定値)。
const PROJECTION_SNAPSHOT_TIMEOUT_MS = 4000;

// 絶対条件(データ最小化): providerConnectionRef/metadataはここで一切
// 読み取らない——フィールド自体が無いため、将来この関数を誤って拡張
// しても、読み取っていない値を送ることは構造的にできない。
function toConnectionProjectionItem(connection: Connection): ConnectionProjectionItem {
  return {
    externalConnectionId: connection.id,
    service: connection.service,
    status: connection.status,
    provider: connection.provider,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

// RUNS_PROJECTION_INGESTION_TOKEN is reused as-is (products/yolna-runs's
// existing lib/projection/ingestionAuth.ts verifies it) — no new auth
// mechanism. RUNS_PROJECTION_BASE_URL is new (this file's only new env
// var): the base URL of the Runs deployment's own origin, e.g.
// "https://runs.example.com". Neither value is ever logged, only whether
// they are present.
export async function sendConnectionProjectionSnapshotBestEffort(
  params: SendConnectionProjectionSnapshotParams,
  deps: SendConnectionProjectionSnapshotDeps = defaultDeps
): Promise<void> {

  const baseUrl = process.env.RUNS_PROJECTION_BASE_URL;
  const token = process.env.RUNS_PROJECTION_INGESTION_TOKEN;

  if (!baseUrl || !token) {

    console.warn(
      "[tact-integration/connectionProjection] RUNS_PROJECTION_BASE_URL/RUNS_PROJECTION_INGESTION_TOKEN " +
      "is not configured; skipping Connection projection snapshot (best-effort — the canonical Connection " +
      "operation already succeeded and is unaffected)."
    );

    return;

  }

  // SOR-212(follow-up fix、絶対条件): snapshotAtはcanonical list read
  // (listConnectionsForUser())より前に確定させる——Runs側のstale
  // snapshot guard(p_snapshot_at <= last_snapshot_atならstale_ignored)
  // は「snapshotAtの大小 = 内容の新しさ」を前提にしている。read後に
  // now()を呼ぶと、DB readが遅延した古いproducer呼び出しが、より新しい
  // canonical operationの後に完了した場合、古い内容なのに新しい
  // snapshotAtを持ってしまい、そのguardを突破して新しいsnapshotを
  // 古い内容で上書きできてしまう。読み取り開始前の時刻を使うことで、
  // snapshotAtの順序が実際のcanonical読み取り開始順序と一致する
  // (読み取り完了順序ではない)ようにする。
  const snapshotAt = deps.now();

  let connections: Connection[];

  try {

    connections = await deps.listConnectionsForUser(params.userId, params.accessToken);

  } catch (error) {

    console.warn(
      "[tact-integration/connectionProjection] listConnectionsForUser() failed while building a snapshot; " +
      "skipping (best-effort).",
      error instanceof Error ? error.message : String(error)
    );

    return;

  }

  const snapshot: ConnectionProjectionSnapshotInput = {
    userId: params.userId,
    snapshotAt,
    connections: connections.map(toConnectionProjectionItem),
  };

  let endpoint: string;

  try {
    endpoint = new URL("/api/tact/runs/ingest/connections", baseUrl).toString();
  } catch {
    console.warn("[tact-integration/connectionProjection] RUNS_PROJECTION_BASE_URL is not a valid URL; skipping (best-effort).");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROJECTION_SNAPSHOT_TIMEOUT_MS);

  try {

    const response = await deps.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });

    if (!response.ok) {

      console.warn(
        `[tact-integration/connectionProjection] Connection projection snapshot was rejected (HTTP ${response.status}); ` +
        "the canonical Connection operation already succeeded and is unaffected."
      );

    }

  } catch (error) {

    // abort(timeout)もネットワークエラーも、ここで必ず握り潰す——
    // 絶対条件(fix#4): このfunctionはどんな失敗モードでもthrowしない。
    console.warn(
      "[tact-integration/connectionProjection] Connection projection snapshot request failed; " +
      "the canonical Connection operation already succeeded and is unaffected.",
      error instanceof Error ? error.message : String(error)
    );

  } finally {

    clearTimeout(timeout);

  }

}
