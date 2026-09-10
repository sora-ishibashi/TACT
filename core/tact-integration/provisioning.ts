import { composioConnectionProvisioningProvider } from "./providers/composio/connectionLink";
import {
  createConnection as defaultCreateConnection,
  getConnection as defaultGetConnection,
  listConnectionsForUser as defaultListConnectionsForUser,
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

  // PRODUCT-P1(Connection UX、OAuth Return Flow): OAuth完了後に
  // ブラウザを差し戻す先(TACT Settings画面のURL)。HTTP層(API route)
  // がrequestのoriginから組み立てた、絶対URLの文字列。省略時は
  // Providerの既定動作(callbackUrlを指定しない場合の挙動)のまま
  // (絶対条件: このfile自身はHTTPを知らないため、origin解決は
  // 呼び出し元の責務のまま維持する)。
  callbackUrl?: string;

}

export interface CreateIntegrationConnectionLinkDeps {

  // Phase C1と同じ理由でproviderKindは今のところ"composio"固定だが、
  // 将来Providerを追加する場合はこのfieldだけを差し替えればよい
  // (Connection.providerを直接文字列リテラルとしてこのfile内に
  // ハードコードしない)。
  providerKind: ConnectionProviderKind;

  provider: ConnectionProvisioningProvider;

  createConnection: typeof defaultCreateConnection;

  // PRODUCT-P1: テスト容易性・決定論性のため、connectionId生成を
  // DI可能にする(既定はNode/ブラウザ双方に存在するグローバル
  // crypto.randomUUID())。呼び出し元がbodyから渡す値ではない
  // ——常にserver側で新規生成する(絶対条件、providerConnectionRef
  // 同様「callerが注入できないfield」)。
  generateConnectionId: () => string;

}

const defaultProvisioningDeps: CreateIntegrationConnectionLinkDeps = {
  providerKind: "composio",
  provider: composioConnectionProvisioningProvider,
  createConnection: defaultCreateConnection,
  generateConnectionId: () => crypto.randomUUID(),
};

// PRODUCT-P1: callbackUrlへTACT canonical connectionIdをquery paramとして
// 埋め込む。OAuth完了後にProviderがこのURLへブラウザを差し戻した際、
// ブラウザ側(Settings画面)がどのConnectionをconfirmすべきかを知るため
// だけに使う——この値はTACT自身が生成したopaqueなUUIDであり、それ単体
// では何の権限も持たない(confirm APIは呼び出し元ごとに所有者を
// 再検証する、既存/api/tact/connections/[connectionId]/confirmの
// 既存契約のまま)。URLとして不正な場合は安全側でcallbackUrlをそのまま
// 返す(例外を投げない)。
function appendConnectionIdToCallbackUrl(callbackUrl: string, connectionId: string): string {

  try {

    const url = new URL(callbackUrl);
    url.searchParams.set("connectionId", connectionId);
    return url.toString();

  } catch {

    return callbackUrl;

  }

}

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

  const { userId, accessToken, service, callbackUrl } = params;

  if (!isSupportedIntegrationService(service)) {
    return { status: "unsupported_service" };
  }

  // PRODUCT-P1: callbackUrlが指定された場合、Providerへlinkを要求する
  // 前にTACT canonical connectionIdを確定させる(このrow自体はまだ
  // 存在しないため、DB defaultのgen_random_uuid()を待たず、ここで
  // 生成したUUIDをそのままprimary keyとして使う——createConnection()
  // 呼び出し時にparams.idとして渡す)。callbackUrl未指定時は従来通り
  // DB側のdefaultへ任せる(既存挙動を変更しない)。
  const preGeneratedConnectionId = callbackUrl ? deps.generateConnectionId() : undefined;

  const resolvedCallbackUrl =
    callbackUrl && preGeneratedConnectionId
      ? appendConnectionIdToCallbackUrl(callbackUrl, preGeneratedConnectionId)
      : undefined;

  // Composio owns: OAuth transport / Connected Account。このfileは
  // 戻り値のproviderConnectionRef(=Composio connected account id)を
  // ただの不透明な参照文字列として受け取るだけで、中身を解釈しない。
  const linkResult = await deps.provider.createConnectionLink(service, userId, resolvedCallbackUrl);

  if (!linkResult) {
    return { status: "provider_not_configured" };
  }

  // TACT owns: canonical Connection state / TACT user ownership。
  // status="active"はここでは絶対に主張しない(絶対条件、CONNECTION
  // PERSISTENCE: providerが実際にACTIVEを返した場合のみactiveにする
  // ——linkResult.canonicalStatusは通常pending、既存
  // toCanonicalConnectionStatus()の導出結果をそのまま使う)。
  const connection = await deps.createConnection(userId, accessToken, {
    id: preGeneratedConnectionId,
    service,
    provider: deps.providerKind,
    providerConnectionRef: linkResult.providerConnectionRef,
    status: linkResult.canonicalStatus,
    metadata: { providerStatusRaw: linkResult.providerStatusRaw },
  });

  return { status: "created", connection, redirectUrl: linkResult.redirectUrl };

}

// =========================
// finalizeConnectionReplacement
// =========================
//
// PRODUCT-P1(Reconnect Lifecycle): 再接続(および初回接続)の両方が
// 通る、唯一のcutover操作。「新しいConnectionがactiveになったことを
// 確認できてから、初めて古いactiveなConnectionを片付ける」という順序
// (絶対条件、最重要: old connectionを先にrevokeしない)をserver-side
// canonical operationとして表現する——browserだけのbest-effortには
// しない(呼び出し元はrefreshIntegrationConnectionStatus()、confirm
// APIが実際にactiveへ遷移した直後にこれを呼ぶ)。
//
// Provider-neutral: このfile自身はComposio固有の識別子を一切扱わない
// (listConnectionsForUser()が返すCanonical Connection.idだけを使う)。
// 将来複数Providerが混在しても、このロジックはuserId/service単位で
// 完結するため変更不要。
//
// 初回接続時(既存activeが無い)も同じ関数を安全に呼べる——
// revokeConnectionIds()が空配列を返すだけの副作用ゼロな呼び出しになる
// (絶対条件: Gmail初回接続とreconnectで別ロジックを持たない)。

export interface FinalizeConnectionReplacementParams {

  userId: string;

  accessToken: string;

  service: IntegrationService;

  // 新しくactiveになったConnection(このidだけは絶対に revoke しない)。
  keepConnectionId: string;

}

export interface FinalizeConnectionReplacementDeps {

  listConnectionsForUser: typeof defaultListConnectionsForUser;

  updateConnectionStatus: typeof defaultUpdateConnectionStatus;

}

const defaultFinalizeDeps: FinalizeConnectionReplacementDeps = {
  listConnectionsForUser: defaultListConnectionsForUser,
  updateConnectionStatus: defaultUpdateConnectionStatus,
};

export interface FinalizeConnectionReplacementOutcome {

  revokedConnectionIds: string[];

}

export async function finalizeConnectionReplacement(
  params: FinalizeConnectionReplacementParams,
  deps: FinalizeConnectionReplacementDeps = defaultFinalizeDeps
): Promise<FinalizeConnectionReplacementOutcome> {

  const { userId, accessToken, service, keepConnectionId } = params;

  // Active Uniqueness(絶対条件6): このuser/serviceの現在active行
  // だけを見る——pending/failed/revokedな過去の行には一切触れない
  // (LIVE-1A False Multiple Connection Resolutionの修正と同じ
  // active-only filterをそのまま再利用する)。
  const activeConnections = await deps.listConnectionsForUser(userId, accessToken, service, "active");

  const toRevoke = activeConnections.filter((connection) => connection.id !== keepConnectionId);

  const revokedConnectionIds: string[] = [];

  for (const connection of toRevoke) {

    await deps.updateConnectionStatus(connection.id, userId, accessToken, "revoked", {
      ...(connection.metadata ?? {}),
      // diagnostics専用(Composio固有の識別子ではない、TACT canonical
      // idのみ)。監査時に「なぜこの行がrevokedになったか」を追える
      // ようにするためだけの非機密メタデータ。
      supersededByConnectionId: keepConnectionId,
    });

    revokedConnectionIds.push(connection.id);

  }

  return { revokedConnectionIds };

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

  // PRODUCT-P1(Reconnect Lifecycle): pending -> activeへ実際に遷移した
  // 直後だけ呼ぶ(既存activeな兄弟Connectionのcutover、絶対条件:
  // 新しい接続が成功してから古いものを片付ける)。
  finalizeConnectionReplacement: typeof finalizeConnectionReplacement;

}

const defaultRefreshDeps: RefreshIntegrationConnectionStatusDeps = {
  getConnection: defaultGetConnection,
  updateConnectionStatus: defaultUpdateConnectionStatus,
  provider: composioConnectionProvisioningProvider,
  finalizeConnectionReplacement,
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

  // PRODUCT-P1(Reconnect Lifecycle、絶対条件、最重要): 新しい接続が
  // 実際にactiveへ遷移したことを確認できた、この瞬間だけcutoverを行う
  // ——old connectionを先にrevokeしない・新しい接続が失敗した場合は
  // 何も片付けない(reconnect failure時にold activeがそのまま残る、
  // 絶対条件Jと同じ結論)。finalize自体の失敗はこのrefreshの成功結果
  // (新しいConnectionは既にactiveへ確定済み)を変更しない——既存
  // reconcileAfterTaskUpdate()等と同じ「非致命的な副次処理はconsole.warn
  // でbest-effort化する」既存パターンを踏襲する。
  if (statusResult.canonicalStatus === "active") {

    try {

      await deps.finalizeConnectionReplacement({
        userId,
        accessToken,
        service: connection.service,
        keepConnectionId: connection.id,
      });

    } catch (error) {

      console.warn(
        "[tact-integration/provisioning] finalizeConnectionReplacement() failed after a connection " +
        "became active; the newly active connection's status is already committed and unaffected. " +
        "Stale sibling active connections (if any) may remain until the next successful reconnect/disconnect.",
        error instanceof Error ? error.message : String(error)
      );

    }

  }

  const refreshed = await deps.getConnection(connectionId, userId, accessToken);

  return { status: "synced", connection: refreshed ?? { ...connection, status: statusResult.canonicalStatus } };

}

// =========================
// disconnectIntegrationConnection
// =========================
//
// PRODUCT-P1(Disconnect、SEC-R1 P1「OAuth revoke/disconnectが無い」への
// 対応): serviceで指定された、このuserの現在activeなConnectionを全て
// revokeする(通常は0または1件だが、error state——複数activeが誤って
// 存在する場合——でも同じ操作で自己修復できるよう、対象は「serviceの
// 現在activeな全行」とする、絶対条件6 Active Uniquenessの回復経路)。
//
// Provider側のConnected Account無効化はbest-effort(絶対条件、設計
// 理由を明示): TACT owns canonical connection state——実行可否は
// core/tact-integration/execution.tsのvalidateConnectionForExecution()
// が「TACT側のstatus==="active"」だけを見て判断するため、Provider側の
// 一時的なネットワーク障害等でdisableConnection()が失敗しても、
// ユーザー自身の解除操作そのものを失敗させない(fail-openにする方が
// 実害が小さい——TACT側のstatusを"revoked"にできなければ、ユーザーは
// 「解除したはずなのに実行できてしまう」というより深刻な状態に陥る。
// 逆にProvider側だけ無効化に失敗しても、TACT側のresolverが既にその
// Connectionを候補から外すため、実害は無い)。

export interface DisconnectIntegrationConnectionParams {

  userId: string;

  accessToken: string;

  service: string;

}

export interface DisconnectIntegrationConnectionDeps {

  provider: ConnectionProvisioningProvider;

  listConnectionsForUser: typeof defaultListConnectionsForUser;

  updateConnectionStatus: typeof defaultUpdateConnectionStatus;

}

const defaultDisconnectDeps: DisconnectIntegrationConnectionDeps = {
  provider: composioConnectionProvisioningProvider,
  listConnectionsForUser: defaultListConnectionsForUser,
  updateConnectionStatus: defaultUpdateConnectionStatus,
};

export type DisconnectIntegrationConnectionOutcome =
  | { status: "unsupported_service" }
  // 既にactiveなConnectionが無い(既に解除済み、または未接続)。
  // 冪等性のため、これもエラーではなく成功として扱う——同じ結果
  // (「activeなConnectionが無い」)へ収束していることが重要
  // (絶対条件: 二重クリックで例外にしない)。
  | { status: "not_connected" }
  | { status: "disconnected"; revokedConnectionIds: string[] };

export async function disconnectIntegrationConnection(
  params: DisconnectIntegrationConnectionParams,
  deps: DisconnectIntegrationConnectionDeps = defaultDisconnectDeps
): Promise<DisconnectIntegrationConnectionOutcome> {

  const { userId, accessToken, service } = params;

  if (!isSupportedIntegrationService(service)) {
    return { status: "unsupported_service" };
  }

  const activeConnections = await deps.listConnectionsForUser(userId, accessToken, service, "active");

  if (activeConnections.length === 0) {
    return { status: "not_connected" };
  }

  const revokedConnectionIds: string[] = [];

  for (const connection of activeConnections) {

    try {

      await deps.provider.disableConnection(connection.providerConnectionRef);

    } catch (error) {

      // best-effort、設計理由は上部コメント参照。TACT canonical revoke
      // (下記)は常に実行する。
      console.warn(
        "[tact-integration/provisioning] disableConnection() (provider-side best-effort) threw; " +
        "proceeding with the canonical TACT-side revoke regardless.",
        error instanceof Error ? error.message : String(error)
      );

    }

    await deps.updateConnectionStatus(connection.id, userId, accessToken, "revoked");
    revokedConnectionIds.push(connection.id);

  }

  return { status: "disconnected", revokedConnectionIds };

}
