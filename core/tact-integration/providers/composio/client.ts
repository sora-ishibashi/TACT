import { Composio } from "@composio/core";

// =========================
// TACT Integration — Composio Client (Architecture Migration Phase C1)
// =========================
//
// Composio SDK(現時点の公式stable package、@composio/core@0.18.1、
// npm/GitHub ComposioHQ/composio確認済み)の初期化だけを担う、この
// Providerの中で最も低レベルなfile。core/tact-integration/providers/
// composio/配下以外のどのfileも@composio/coreを一切importしない
// (絶対条件、Phase C1指示Section5「Composio SDK importをprovider
// layer外へ拡散させない」)。
//
// 絶対条件(Phase C1指示Section12): Composio API keyはserver-onlyで
// あり、client component/browser bundle/Bot action payload/Approval
// payloadへ一切渡さない。この値を読み出すのはこのfileだけ
// (core/database/supabaseServiceRole.tsのgetServiceRoleKey()と同じ
// 「秘密情報の読み出し箇所を1つに閉じ込める」設計)。
//
// isComposioConfigured()が既定でfalseの環境(COMPOSIO_API_KEY未設定、
// このrepositoryのtest/開発環境の既定状態)では、Composioクライアント
// を一切構築しない——SDK自身がAPI key欠如時にconstructor内で例外を
// 投げる(ComposioNoAPIKeyError、@composio/core/src/utils/sdk.tsで
// 確認済み)ため、未設定時は先にnullを返して安全にfallbackする
// (core/database/supabaseServiceRole.tsのisServiceRoleConfigured()
// と同じ既存パターン)。

let cachedClient: Composio | null | undefined;

export function isComposioConfigured(): boolean {

  return (
    typeof process.env.COMPOSIO_API_KEY === "string" &&
    process.env.COMPOSIO_API_KEY.length > 0
  );

}

// Phase C1指示Section22(Toolkit versioning): 現在の公式SDKは
// `dangerouslySkipVersionCheck: true`を明示しない限り、
// toolkitVersionが"latest"(既定値)のままの手動tool実行を
// ComposioToolVersionRequiredErrorで拒否する仕様
// (@composio/core/src/models/Tools.ts確認済み)。productionで具体的な
// dated version(例: "20250909_00")をpinしたい場合は
// COMPOSIO_SLACK_TOOLKIT_VERSION環境変数で指定できるようにする
// (未設定時は"latest"のまま、Adapter側がdangerouslySkipVersionCheck:
// trueを明示することで動作させる——version管理システムを巨大化
// しない、Phase C1指示Section22)。
export function getSlackToolkitVersion(): string {

  return process.env.COMPOSIO_SLACK_TOOLKIT_VERSION || "latest";

}

export function getGmailToolkitVersion(): string {

  return process.env.COMPOSIO_GMAIL_TOOLKIT_VERSION || "latest";

}

export function getNotionToolkitVersion(): string {

  return process.env.COMPOSIO_NOTION_TOOLKIT_VERSION || "latest";

}

export function getComposioClient(): Composio | null {

  if (!isComposioConfigured()) {
    return null;
  }

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  cachedClient = new Composio({
    apiKey: process.env.COMPOSIO_API_KEY,
    toolkitVersions: {
      slack: getSlackToolkitVersion(),
      gmail: getGmailToolkitVersion(),
      notion: getNotionToolkitVersion(),
    },
  });

  return cachedClient;

}

// =========================
// toComposioUserId
// =========================
//
// 絶対条件(Phase C1指示Section11): Composio側のuser/entity identity
// とTACT user identityを混同しない。Composio identityをCanonical
// User.idにせず、外部Channel user idも使わない——常にTACT側で
// server側解決済みのuserId(core/tact-work/のWork.userIdと同じ値)
// から、決定論的にnamespace付きの文字列を導出するだけ(Composio側に
// 事前登録は不要、userIdは呼び出し時に指定するただの分割キー、
// @composio/core公式docs「Sessions and User Scoping」確認済み)。
export function toComposioUserId(tactUserId: string): string {

  return `tact_user_${tactUserId}`;

}
