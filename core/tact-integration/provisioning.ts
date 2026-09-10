import { composioConnectionProvisioningProvider } from "./providers/composio/connectionLink";
import {
  createConnection as defaultCreateConnection,
  getConnection as defaultGetConnection,
  updateConnectionStatus as defaultUpdateConnectionStatus,
} from "./connection";
import type {
  Connection,
  ConnectionProviderKind,
  ConnectionProvisioningProvider,
  IntegrationService,
} from "./types";

// =========================
// TACT Integration — Connection Provisioning
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// TACT authenticated user -> trusted tactUserId -> canonical
// provider-neutral connection request -> Provider OAuth link ->
// (人間がOAuthを完了) -> TACT-owned canonical tact_connectionsという
// 一連の流れのうち、「TACT側の入口」を担う唯一のfile。
//
// 絶対条件(LIVE-1A指示、最重要): このfileはProvider(Composio)固有の
// 識別子・Tool slug・Auth Config ID解決ロジックを一切知らない
// (core/tact-integration/types.tsのConnectionProvisioningProviderと
// いう抽象越しにだけProviderへ触れる、gateway.ts/execution.tsと
// 全く同じ設計)。将来Composio以外のProviderを追加する場合も、この
// fileの変更は「defaultProvisioningDeps.provider/providerKindの
// 差し替え」だけで済む。
//
// 識別不変条件(IDENTITY INVARIANT、絶対条件・最重要): provisioning時
// (composioConnectionProvisioningProvider.createConnectionLink()内部が
// 呼ぶtoComposioUserId(tactUserId))とexecution時
// (core/tact-integration/providers/composio/adapter.tsのexecuteComposio()
// が呼ぶtoComposioUserId(request.userId))は、全く同じ決定論的関数
// (core/tact-integration/providers/composio/client.tsのtoComposioUserId())
// を、全く同じ入力(TACT canonical userId)で呼ぶ。この2箇所が構造的に
// 分岐しないことをtests/tact/integration/connectionProvisioning.test.ts
// が正規表現でsource-level検証する(既存tests/tact/integration/
// connectionSchema.test.tsと同じ「migration/sourceをテキストとして
// 検証する」既存手法を踏襲)。
//
// トラスト境界(絶対条件): このfile自身はHTTPリクエストを一切知らない
// (Request/NextRequestをimportしない)。呼び出し元(app/api/tact/
// connections/route.ts)がgetCurrentUserContext()で解決済みの
// userId/accessTokenだけを受け取る——bodyのuserId・
// providerConnectionRef・Composio識別子をこのfileが信用することは
// 構造的に無い(そもそもこのfileのparamsにそれらの入力欄が存在しない)。

// =========================
// createIntegrationConnectionLink
// =========================

export interface CreateIntegrationConnectionLinkParams {

  // trusted server側で解決済みのTACT userId(HTTP層のbody由来では
  // ない、絶対条件)。
  userId: string;

  accessToken: string;

  // Canonical service識別子。呼び出し元がstringのまま渡してもよい
  // (HTTP bodyから来る未検証値をこのfile自身がここで検証する)。
  service: string;

}

export interface CreateIntegrationConnectionLinkDeps {

  // Phase C1と同じ理由でproviderKindは今のところ"composio"固定だが、
  // 将来Providerを追加する場合はこのfieldだけを差し替えればよい
  // (Connection.providerを直接文字列リテラルとしてこのfile内に
  // ハードコードしない)。
  providerKind: ConnectionProviderKind;

  provider: ConnectionProvisioningProvider;

  createConnection: typeof defaultCreateConnection;

}

const defaultProvisioningDeps: CreateIntegrationConnectionLinkDeps = {
  providerKind: "composio",
  provider: composioConnectionProvisioningProvider,
  createConnection: defaultCreateConnection,
};

// Phase C1のIntegrationService("slack"|"gmail")と同じcanonical
// serviceだけをサポートする——unsupported serviceはfail closedする
// (絶対条件、TRUST BOUNDARY「fail closed for unsupported service」)。
function isSupportedIntegrationService(service: string): service is IntegrationService {
  return service === "slack" || service === "gmail";
}

export type CreateIntegrationConnectionLinkOutcome =
  | { status: "unsupported_service" }
  // Provider側の設定欠如(例: COMPOSIO_API_KEY/COMPOSIO_GMAIL_AUTH_
  // CONFIG_ID未設定)。呼び出し元(API route)がこれをuser向けの
  // 「現在この接続は利用できません」というメッセージへ変換する
  // (このfile自体はHTTP statusを持たない)。
  | { status: "provider_not_configured" }
  | { status: "created"; connection: Connection; redirectUrl: string | null };

export async function createIntegrationConnectionLink(
  params: CreateIntegrationConnectionLinkParams,
  deps: CreateIntegrationConnectionLinkDeps = defaultProvisioningDeps
): Promise<CreateIntegrationConnectionLinkOutcome> {

  const { userId, accessToken, service } = params;

  if (!isSupportedIntegrationService(service)) {
    return { status: "unsupported_service" };
  }

  // Composio owns: OAuth transport / Connected Account。このfileは
  // 戻り値のproviderConnectionRef(=Composio connected account id)を
  // ただの不透明な参照文字列として受け取るだけで、中身を解釈しない。
  const linkResult = await deps.provider.createConnectionLink(service, userId);

  if (!linkResult) {
    return { status: "provider_not_configured" };
  }

  // TACT owns: canonical Connection state / TACT user ownership。
  // status="active"はここでは絶対に主張しない(絶対条件、CONNECTION
  // PERSISTENCE: providerが実際にACTIVEを返した場合のみactiveにする
  // ——linkResult.canonicalStatusは通常pending、既存
  // toCanonicalConnectionStatus()の導出結果をそのまま使う)。
  const connection = await deps.createConnection(userId, accessToken, {
    service,
    provider: deps.providerKind,
    providerConnectionRef: linkResult.providerConnectionRef,
    status: linkResult.canonicalStatus,
    metadata: { providerStatusRaw: linkResult.providerStatusRaw },
  });

  return { status: "created", connection, redirectUrl: linkResult.redirectUrl };

}

// =========================
// refreshIntegrationConnectionStatus
// =========================
//
// OAuthはComposio(Provider)側のホスト済みredirectUrlで完結するため、
// TACTがCallback/Webhookを受け取るentrypointを持たない(絶対条件:
// .envを触らない・新しいWebhook infrastructureを追加しない、
// このPhaseのscope外)。代わりに、TACT側から明示的にProviderの現在
// statusを問い合わせ、必要な場合だけcanonical statusを進める
// (絶対条件CONNECTION PERSISTENCE「If the current Composio SDK
// requires a callback/polling step ... implement the minimum safe
// version」)。
//
// 呼び出し元(app/api/tact/connections/[connectionId]/confirm/route.ts)
// が、OAuth完了後にユーザー操作(またはLIVE acceptanceの手動確認)を
// 起点として1回呼ぶ想定——自動pollingループはこのfileも呼び出し元も
// 持たない(絶対条件、無制限なProvider呼び出しを増やさない)。

export interface RefreshIntegrationConnectionStatusParams {

  connectionId: string;

  userId: string;

  accessToken: string;

}

export interface RefreshIntegrationConnectionStatusDeps {

  getConnection: typeof defaultGetConnection;

  updateConnectionStatus: typeof defaultUpdateConnectionStatus;

  provider: ConnectionProvisioningProvider;

}

const defaultRefreshDeps: RefreshIntegrationConnectionStatusDeps = {
  getConnection: defaultGetConnection,
  updateConnectionStatus: defaultUpdateConnectionStatus,
  provider: composioConnectionProvisioningProvider,
};

export type RefreshIntegrationConnectionStatusOutcome =
  // 所有者不一致・存在しないconnectionIdのいずれも既存
  // getConnection()の規約通りundefinedへ折り畳まれるため、この境界も
  // 同じ「存在しない場合と同じ扱い」を返す(IDOR対策、既存パターン
  // 踏襲)。
  | { status: "not_found" }
  // 将来Providerが増えた場合、Connection.providerに対応する
  // ConnectionProvisioningProvider実装をこのfileが選べない状態
  // (現状は常にcomposioのみのため到達しない、防御的分岐)。
  | { status: "unsupported_provider" }
  | { status: "provider_not_configured" }
  | { status: "synced"; connection: Connection };

export async function refreshIntegrationConnectionStatus(
  params: RefreshIntegrationConnectionStatusParams,
  deps: RefreshIntegrationConnectionStatusDeps = defaultRefreshDeps
): Promise<RefreshIntegrationConnectionStatusOutcome> {

  const { connectionId, userId, accessToken } = params;

  const connection = await deps.getConnection(connectionId, userId, accessToken);

  if (!connection) {
    return { status: "not_found" };
  }

  if (connection.provider !== "composio") {
    return { status: "unsupported_provider" };
  }

  if (connection.status === "active") {
    // 既にactiveなConnectionを再度Providerへ問い合わせない(絶対条件:
    // 不要なProvider呼び出しを増やさない)。
    return { status: "synced", connection };
  }

  const statusResult = await deps.provider.getConnectionStatus(connection.providerConnectionRef);

  if (!statusResult) {
    return { status: "provider_not_configured" };
  }

  if (statusResult.canonicalStatus === connection.status) {
    return { status: "synced", connection };
  }

  await deps.updateConnectionStatus(
    connection.id,
    userId,
    accessToken,
    statusResult.canonicalStatus,
    { ...(connection.metadata ?? {}), providerStatusRaw: statusResult.providerStatusRaw }
  );

  const refreshed = await deps.getConnection(connectionId, userId, accessToken);

  return { status: "synced", connection: refreshed ?? { ...connection, status: statusResult.canonicalStatus } };

}
