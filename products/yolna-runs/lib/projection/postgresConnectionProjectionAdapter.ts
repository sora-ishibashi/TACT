// =========================
// Yolna Runs Standalone — Postgres-backed Connection Projection Adapter (SOR-212)
// =========================
//
// Standalone Runs' OWN implementation of @tact/execution-contract's
// ConnectionProjectionRepository (read side) / ConnectionProjectionWriter
// (write side — the Yolna -> Runs projection contract for Connection).
// Reads/writes ONLY this deployment's own
// tact_runs_connection_projection / tact_runs_connection_projection_state
// tables (products/yolna-runs/supabase/migrations/
// 20270101000017_create_tact_runs_connection_projection.sql) via this app's
// own Supabase service-role client.
//
// Same isolation discipline as lib/projection/postgresProjectionAdapter.ts:
// this file has no dependency on Yolna's source tree, database, or
// credentials, and must never be imported from the root Yolna application
// (enforced by scripts/verify/standaloneForbiddenImports.ts, which scans
// the other direction, and scripts/verify/rootForbiddenStandaloneImport.ts,
// which scans this one).
//
// Unlike postgresProjectionAdapter.ts, this file accepts an injectable
// `deps` (same pattern as packages/runs-core's registryStore.ts/
// coverage/store.ts) so its real logic — not a hand-rolled substitute —
// can be exercised against an in-memory fake Supabase client in
// scripts/connectionProjection.test.ts, without a real database connection.
// Production code uses the plain exported singletons below, which close
// over the real getServiceRoleClient — callers never pass deps themselves.

import { getServiceRoleClient } from "@tact/runs-core/database/supabaseServiceRole";
import type {
  ConnectionProjectionItem,
  ConnectionProjectionRepository,
  ConnectionProjectionSnapshotInput,
  ConnectionProjectionSnapshotState,
  ConnectionProjectionStatus,
  ConnectionProjectionWriter,
} from "@tact/execution-contract";

type Client = NonNullable<ReturnType<typeof getServiceRoleClient>>;

export interface ConnectionProjectionAdapterDeps {
  getClient: () => Client | null;
}

const defaultDeps: ConnectionProjectionAdapterDeps = { getClient: getServiceRoleClient };

interface ConnectionProjectionRow {
  external_connection_id: string;
  service: string;
  status: ConnectionProjectionStatus;
  provider: string;
  source_created_at: string;
  source_updated_at: string;
}

const PROJECTION_COLUMNS =
  "external_connection_id, service, status, provider, source_created_at, source_updated_at";

function toConnectionProjectionItem(row: ConnectionProjectionRow): ConnectionProjectionItem {
  return {
    externalConnectionId: row.external_connection_id,
    service: row.service,
    status: row.status,
    provider: row.provider,
    createdAt: row.source_created_at,
    updatedAt: row.source_updated_at,
  };
}

// Fail closed, not fail silent (same reasoning as postgresProjectionAdapter.ts's
// requireClient()): an unconfigured service role is a distinct failure from
// "no snapshot has ever completed" — the former throws, the latter (a real,
// successful read reporting the state row's absence) returns
// readState: "unavailable" normally, never an exception.
function requireClient(deps: ConnectionProjectionAdapterDeps): Client {
  const client = deps.getClient();
  if (!client) {
    throw new Error(
      "[yolna-runs/lib/projection] Supabase service role is not configured " +
      "(NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — cannot read or write the Connection projection."
    );
  }
  return client;
}

export function createPostgresConnectionProjectionRepository(
  deps: ConnectionProjectionAdapterDeps = defaultDeps
): ConnectionProjectionRepository {

  return {

    // 絶対条件(SOR-212): state行の有無だけがreadStateを決める——
    // tact_runs_connection_projectionの行数を一切見ない(0件の
    // projectionと「一度もsnapshotが届いていない」を区別するのが
    // このtableの唯一の目的)。
    async getSnapshotState(userId: string): Promise<ConnectionProjectionSnapshotState> {

      const client = requireClient(deps);

      const { data } = await client
        .from("tact_runs_connection_projection_state")
        .select("last_snapshot_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (!data) {
        return { readState: "unavailable", lastSnapshotAt: null };
      }

      return {
        readState: "available",
        lastSnapshotAt: (data as { last_snapshot_at: string }).last_snapshot_at,
      };

    },

    // service-role使用時でもapplication-level user filterを必須で適用する
    // (絶対条件、RLSを唯一の防御層にしない——他のRuns Core storeと同じ
    // 既存規律)。
    async listConnectionsForUser(userId: string): Promise<ConnectionProjectionItem[]> {

      const client = requireClient(deps);

      const { data } = await client
        .from("tact_runs_connection_projection")
        .select(PROJECTION_COLUMNS)
        .eq("user_id", userId);

      return (data ?? []).map((row) => toConnectionProjectionItem(row as ConnectionProjectionRow));

    },

  };

}

export function createPostgresConnectionProjectionWriter(
  deps: ConnectionProjectionAdapterDeps = defaultDeps
): ConnectionProjectionWriter {

  return {

    // 絶対条件(SOR-212、fail-closed): atomicityはmigrationのRPC
    // (replace_tact_runs_connection_projection_snapshot、単一関数呼び出し
    // = 単一transaction)が保証する——このfileは呼び出すだけで、
    // 部分書き込み後にstateを進めるような分割ロジックを一切持たない。
    async replaceSnapshot(input: ConnectionProjectionSnapshotInput): Promise<void> {

      const client = requireClient(deps);

      const { error } = await client.rpc("replace_tact_runs_connection_projection_snapshot", {
        p_user_id: input.userId,
        p_snapshot_at: input.snapshotAt,
        p_connections: input.connections,
      });

      if (error) {
        throw new Error(`[yolna-runs/lib/projection] replaceSnapshot failed: ${error.message}`);
      }

    },

  };

}

export const postgresConnectionProjectionRepository: ConnectionProjectionRepository =
  createPostgresConnectionProjectionRepository();

export const postgresConnectionProjectionWriter: ConnectionProjectionWriter =
  createPostgresConnectionProjectionWriter();
