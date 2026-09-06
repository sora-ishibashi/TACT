import { getComposioClient, toComposioUserId } from "./client";

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
