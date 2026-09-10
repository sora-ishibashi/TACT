import { getComposioClient, toComposioUserId } from "./client";
import type { ConnectionProvisioningProvider, IntegrationService } from "../../types";

// =========================
// TACT Integration — Composio Connection Link
// (Architecture Migration Phase C1)
// =========================
//
// 最小限のOAuth/Connected Account boundary(Phase C1指示Section13:
// 巨大なConnections UIは作らない。現在のComposio公式SDKが安全に
// connection initiation/link生成を提供している場合、function
// boundaryとして実装してよい、というscope)。
//
// 確認済み事実(@composio/core@0.18.1、ConnectedAccounts.ts確認済み):
//   - `composio.connectedAccounts.link(userId, authConfigId, options?)`
//     が現行の推奨API(旧`.initiate()`のlegacy endpointは2026-07-03
//     以降廃止予定であることがSDKコメント内に明記されている)。
//   - 戻り値`ConnectionRequest`は`.id`・`.redirectUrl`・
//     `.waitForConnection()`を持つ。
//   - `composio.connectedAccounts.get(id)`で現在のstatus
//     (INITIALIZING|INITIATED|ACTIVE|FAILED|EXPIRED|INACTIVE|REVOKED)
//     を取得できる(types/connectedAccounts.types.ts確認済み)。
//
// authConfigIdはComposio dashboard側で事前に作成されたSlack Auth
// Configを指す、Composio側の設定値であり、TACTのcredentialではない
// (OAuth clientの実体はComposio側にある)。環境変数
// COMPOSIO_SLACK_AUTH_CONFIG_IDで渡す。
//
// このfileはUIを一切持たない(絶対条件: UI redesign禁止)——
// redirectUrlを返すだけで、実際にユーザーへ提示する方法(Web
// route/Bot DM等)は呼び出し元の責務。

export function isSlackAuthConfigured(): boolean {

  return (
    typeof process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID === "string" &&
    process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID.length > 0
  );

}

export interface SlackConnectionLinkResult {

  // Composio ConnectionRequest.id(=将来tact_connections.provider_
  // connection_refとして保存する値の候補。実際にActiveになった
  // ことを確認してからConnectionを永続化するのは呼び出し元の責務)。
  providerConnectionRequestId: string;

  // schema上optional/nullable(redirect不要なauth方式の余地)。
  // 実際にはOAuthフローではほぼ必ず設定される。
  redirectUrl: string | null;

}

// COMPOSIO_API_KEY/COMPOSIO_SLACK_AUTH_CONFIG_IDのいずれかが未設定
// の場合はnullを返し、安全にfallbackする(実DBアクセス・実HTTP
//呼び出しを一切行わない、既存のisServiceRoleConfigured()等と同じ
// パターン)。
export async function createSlackConnectionLink(
  tactUserId: string
): Promise<SlackConnectionLinkResult | null> {

  const client = getComposioClient();
  const authConfigId = process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID;

  if (!client || !authConfigId) {
    return null;
  }

  const connectionRequest = await client.connectedAccounts.link(
    toComposioUserId(tactUserId),
    authConfigId
  );

  return {
    providerConnectionRequestId: connectionRequest.id,
    redirectUrl: connectionRequest.redirectUrl ?? null,
  };

}

// Composio側の詳細status(INITIALIZING|INITIATED|ACTIVE|FAILED|
// EXPIRED|INACTIVE|REVOKED)を、TACT Canonical ConnectionStatus
// (pending|active|failed|revoked)へ変換する。Provider固有の詳細
// (元のComposio status文字列)はmetadataとして別途保持することを
// 呼び出し元に委ねる(この関数はCanonical statusの導出だけを行う)。
export function toCanonicalConnectionStatus(
  composioStatus: string
): "pending" | "active" | "failed" | "revoked" {

  switch (composioStatus) {
    case "ACTIVE":
      return "active";
    case "FAILED":
    case "EXPIRED":
      return "failed";
    case "INACTIVE":
    case "REVOKED":
      return "revoked";
    case "INITIALIZING":
    case "INITIATED":
    default:
      return "pending";
  }

}

// 実行中のconnection requestの現在状態を確認する(pollingは
// 呼び出し元の責務、このfile自体はUIも待機ループも持たない)。
export async function getSlackConnectionStatus(
  providerConnectionRef: string
): Promise<{ canonicalStatus: "pending" | "active" | "failed" | "revoked"; rawStatus: string } | null> {

  const client = getComposioClient();

  if (!client) {
    return null;
  }

  const account = await client.connectedAccounts.get(providerConnectionRef);

  return {
    canonicalStatus: toCanonicalConnectionStatus(account.status),
    rawStatus: account.status,
  };

}

// =========================
// Generic (provider-neutral service) Connection Provisioning
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// 上記のcreateSlackConnectionLink()/getSlackConnectionStatus()は
// Phase C1(Slack単独)時点の命名のまま変更しない(既存呼び出し元
// (composioClient.test.ts)への互換性を壊さない、絶対条件7「既存API
// との互換性を壊す変更」を避けるため)。
//
// 以下はGmailを含む複数serviceに対応する、canonical
// ConnectionProvisioningProvider(core/tact-integration/types.ts)の
// Composio実装。呼び出し元(core/tact-integration/provisioning.ts)は
// serviceごとのAuth Config IDやComposio固有のstatus語彙を一切知らず、
// この境界だけがそれを解決する(絶対条件、Section「Composio owns:
// OAuth transport」)。
//
// serviceごとのAuth Config ID解決: Slackは既存のCOMPOSIO_SLACK_
// AUTH_CONFIG_IDをそのまま再利用する(新しい環境変数を増やさない)。
// Gmailは新規にCOMPOSIO_GMAIL_AUTH_CONFIG_IDを追加する(値は.envへ
// 書き込まない——LIVE instructionsとしてユーザーへVercel環境変数の
// 設定を依頼するだけ)。
function getComposioAuthConfigId(service: IntegrationService): string | undefined {

  switch (service) {
    case "slack":
      return process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID;
    case "gmail":
      return process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
  }

}

// 呼び出し元(API route等)がuser向けに「このserviceは接続可能か」を
// 判断するための最小限のヘルパー(isSlackAuthConfigured()と同じ
// fallbackパターンをservice非依存へ一般化しただけ)。
export function isComposioServiceAuthConfigured(service: IntegrationService): boolean {

  return (
    typeof getComposioAuthConfigId(service) === "string" &&
    (getComposioAuthConfigId(service) as string).length > 0
  );

}

// createSlackConnectionLink()と全く同じ実装だが、Auth Config ID解決を
// service引数で汎化しただけ(絶対条件、識別不変条件: ここでも必ず
// toComposioUserId(tactUserId)を使う——execution.ts/adapter.tsの
// executeComposio()と全く同じ関数を同じ引数で呼ぶことで、provisioning
// 時とexecution時のComposio user識別子が構造的に一致する)。
// PRODUCT-P1(Connection UX、OAuth Return Flow): callbackUrlは
// CreateConnectedAccountLinkOptions.callbackUrl(@composio/core確認済み、
// LinkCreateParams.callback_url)へそのまま渡す。Composioは、Provider
// (Google/Slack等)とのOAuthが完了した後、ブラウザをこのURLへ差し戻す
// 契約(SDK/API docs確認済み)——TACTがCallback/Webhookを自前で
// ホストしなくても、既存のTACT Settings画面へブラウザを戻せる。
export async function createComposioConnectionLink(
  service: IntegrationService,
  tactUserId: string,
  callbackUrl?: string
): Promise<{ connectedAccountId: string; redirectUrl: string | null; rawStatus: string } | null> {

  const client = getComposioClient();
  const authConfigId = getComposioAuthConfigId(service);

  if (!client || !authConfigId) {
    return null;
  }

  const connectionRequest = await client.connectedAccounts.link(
    toComposioUserId(tactUserId),
    authConfigId,
    callbackUrl ? { callbackUrl } : undefined
  );

  return {
    connectedAccountId: connectionRequest.id,
    redirectUrl: connectionRequest.redirectUrl ?? null,
    // SDK自身の既定(createConnectionRequest()、@composio/core/src/models/
    // ConnectionRequest.ts確認済み)と同じfallbackを使う——link()直後の
    // ConnectionRequest.statusはoptional型だが、SDK内部では常に
    // "INITIATED"が既定値として設定される。
    rawStatus: connectionRequest.status ?? "INITIATED",
  };

}

// getSlackConnectionStatus()と全く同じ実装(そもそもSlack固有の分岐を
// 元々含んでいなかった)を、service非依存の名前でも公開する——
// 呼び出し元(core/tact-integration/provisioning.ts)がSlack由来の
// 名前をimportしなくて済むようにするためだけの別名。
export async function getComposioConnectionStatus(
  providerConnectionRef: string
): Promise<{ canonicalStatus: "pending" | "active" | "failed" | "revoked"; rawStatus: string } | null> {

  return getSlackConnectionStatus(providerConnectionRef);

}

// PRODUCT-P1(Disconnect): Connected Accountの非破壊的な無効化。
// installed @composio/core SDK確認済み(ConnectedAccounts.ts、
// disable()メソッド、内部的にupdateStatus(nanoid, {enabled:false})を
// 呼ぶだけ——delete()のような不可逆な操作ではない)。best-effortの
// ため例外を一切外へ投げない(呼び出し元のcanonical revoke判断は
// この結果に依存しない、絶対条件)。
export async function disableComposioConnection(
  providerConnectionRef: string
): Promise<boolean> {

  const client = getComposioClient();

  if (!client) {
    return false;
  }

  try {

    await client.connectedAccounts.disable(providerConnectionRef);
    return true;

  } catch (error) {

    console.warn(
      "[tact-integration/composio] disableComposioConnection() best-effort disable failed " +
      "(canonical status still becomes 'revoked' regardless — TACT owns canonical connection state)",
      error instanceof Error ? error.message : String(error)
    );

    return false;

  }

}

// core/tact-integration/types.tsのConnectionProvisioningProviderを
// 満たす、Composio実装(唯一の実装、Phase C1と同じ理由)。Canonical
// layer(provisioning.ts)はこのオブジェクトだけを既定実装として使う。
export const composioConnectionProvisioningProvider: ConnectionProvisioningProvider = {

  async createConnectionLink(service, tactUserId, callbackUrl) {

    const result = await createComposioConnectionLink(service, tactUserId, callbackUrl);

    if (!result) {
      return null;
    }

    return {
      providerConnectionRef: result.connectedAccountId,
      redirectUrl: result.redirectUrl,
      canonicalStatus: toCanonicalConnectionStatus(result.rawStatus),
      providerStatusRaw: result.rawStatus,
    };

  },

  async getConnectionStatus(providerConnectionRef) {

    const result = await getComposioConnectionStatus(providerConnectionRef);

    if (!result) {
      return null;
    }

    return {
      canonicalStatus: result.canonicalStatus,
      providerStatusRaw: result.rawStatus,
    };

  },

  async disableConnection(providerConnectionRef) {

    return disableComposioConnection(providerConnectionRef);

  },

};
