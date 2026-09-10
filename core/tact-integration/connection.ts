import { createClient } from "@supabase/supabase-js";
import type {
  Connection,
  ConnectionStatus,
  ConnectionProviderKind,
  IntegrationService,
} from "./types";

// =========================
// TACT Integration — Connection Store (Architecture Migration Phase C1)
// =========================
//
// core/tact-integration/のConnection永続化層。supabase/migrations/
// 20260907000000_create_tact_connections.sqlを対象とする
// (Stage1 RLS、auth.uid()=user_id)。
//
// 重要(core/tact-conversation/store.ts・core/tact-work/store.tsと
// 全く同じ理由・同じPattern): core/database/supabase.tsの共有
// クライアントはanonキーのみで生成されておりSupabaseセッションを
// 引き継がないため、検証済みのaccess_tokenをAuthorizationヘッダー
// として持つ、リクエストごとのクライアントを構築する。
//
// 絶対条件(RLSをAPIの代わりとして扱わない、既存方針そのまま):
// RLS前提のクライアントを使う場合でも、各関数は明示的に`.eq(...)`を
// 伴うクエリを組み立てる。RLSは最後の防御層として維持し、所有者
// 判定の主たるロジックはこのファイル(アプリケーション層)に置く。
//
// Service role keyはこのfileへ一切importしない(core/database/
// supabaseServiceRole.tsの既存方針通り、Bot Trusted Actor経路でも
// 通常のuser access token/service role tokenをaccessTokenとして
// 受け取るだけで、Credentialという値そのものをこのfileが扱うことは
// 無い)。

function createRequestScopedClient(accessToken: string) {

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );

}

// =========================
// DB row 型
// =========================

export interface ConnectionRow {
  id: string;
  user_id: string;
  service: IntegrationService;
  status: ConnectionStatus;
  provider: ConnectionProviderKind;
  provider_connection_ref: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export function toConnection(row: ConnectionRow): Connection {

  return {
    id: row.id,
    userId: row.user_id,
    service: row.service,
    status: row.status,
    provider: row.provider,
    providerConnectionRef: row.provider_connection_ref,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

const CONNECTION_COLUMNS =
  "id, user_id, service, status, provider, provider_connection_ref, metadata, created_at, updated_at";

// =========================
// createConnection
// =========================
//
// 絶対条件(Phase C1指示Section8/12): token/credential/secretは
// paramsにも列にも一切含めない——呼び出し元(Composio Adapter/
// connection link boundary)はprovider_connection_ref(参照文字列)
// だけを渡す。

export interface CreateConnectionParams {

  // PRODUCT-P1(Connection UX、OAuth Return Flow): optionalな
  // pre-generated id。省略時は既存通りDB側のdefault
  // gen_random_uuid()に任せる(既存呼び出し元の挙動は一切変わらない、
  // 絶対条件)。呼び出し元(provisioning.ts)がOAuth完了後の
  // callbackUrlへこのidを埋め込みたい場合、Providerへlinkを要求する
  // 前(=このrow自体がまだ存在しない時点)にidを確定させる必要が
  // あるため、crypto.randomUUID()で生成した値をここで指定できるように
  // する。値の生成元は常にTACT server側であり、呼び出し元がbodyの
  // clientから受け取った値をそのまま渡すことは無い(絶対条件、
  // providerConnectionRef同様に「callerが注入できるfield」にしない)。
  id?: string;

  service: IntegrationService;

  provider: ConnectionProviderKind;

  providerConnectionRef: string;

  status?: ConnectionStatus;

  metadata?: Record<string, unknown> | null;

}

export async function createConnection(
  userId: string,
  accessToken: string,
  params: CreateConnectionParams
): Promise<Connection> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_connections")
    .insert({
      ...(params.id ? { id: params.id } : {}),
      user_id: userId,
      service: params.service,
      provider: params.provider,
      provider_connection_ref: params.providerConnectionRef,
      status: params.status ?? "pending",
      metadata: params.metadata ?? null,
    })
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toConnection(data as ConnectionRow);

}

// =========================
// getConnection
// =========================
//
// 所有者不一致・存在しない場合のいずれもundefinedを返す
// (core/tact-conversation/store.tsのgetConversation()・
// core/tact-work/store.tsのgetWork()と同じ既存規約)。
export async function getConnection(
  connectionId: string,
  userId: string,
  accessToken: string
): Promise<Connection | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toConnection(data as ConnectionRow);

}

// =========================
// listConnectionsForUser
// =========================
//
// LIVE-1A False Multiple Connection Resolution(READ-ONLY AUDIT確定済み
// root cause): この関数はuser_id/serviceしかfilterしておらず、statusを
// 一切見ていなかった。呼び出し元(core/tact-conversation/orchestration.ts
// のresolveIntegrationConnectionViaTactIntegration()等)はこの結果の
// 件数だけでsingle/multipleを判定するため、Gmail provisioningを複数回
// 行った履歴に由来するpending/failed/revoked行までもが「複数の候補」
// として誤って数えられ、実際にはactiveが1件しか無いにもかかわらず
// "複数連携"という誤判定が発生していた。
//
// 修正方針(絶対条件、最小修正): statusは新設のoptional第4引数とし、
// 省略時の挙動(既存呼び出し元、例: app/api/tact/connections/route.ts
// のGET一覧・tests/tact/integration/connectionProvisioning.test.ts)は
// 一切変更しない(全statusを返す、既存の既定動作のまま)。呼び出し元
// (resolver)側が「activeだけを候補にする」という判断を明示的に行う
// ——この関数自体はGmail固有の分岐を一切持たない(provider非依存・
// service非依存のまま、絶対条件)。
export async function listConnectionsForUser(
  userId: string,
  accessToken: string,
  service?: IntegrationService,
  status?: ConnectionStatus
): Promise<Connection[]> {

  const client = createRequestScopedClient(accessToken);

  let query = client
    .from("tact_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId);

  if (service) {
    query = query.eq("service", service);
  }

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toConnection(row as ConnectionRow));

}

// =========================
// updateConnectionStatus
// =========================
//
// Provider側の詳細status(例: Composioの"INITIALIZING"等)は
// metadataへ格納する呼び出し元の責務とし、この関数自体は
// Canonical statusとmetadataの更新だけを行う。

export async function updateConnectionStatus(
  connectionId: string,
  userId: string,
  accessToken: string,
  status: ConnectionStatus,
  metadata?: Record<string, unknown> | null
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (metadata !== undefined) {
    update.metadata = metadata;
  }

  const { error } = await client
    .from("tact_connections")
    .update(update)
    .eq("id", connectionId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

}
