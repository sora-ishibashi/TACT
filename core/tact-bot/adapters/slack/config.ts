// =========================
// TACT Bot — Slack Adapter Config (S1a)
// =========================
//
// SLACK_SIGNING_SECRETの読み出しをこのfileだけに閉じ込める
// (core/database/supabaseServiceRole.ts・core/tact-integration/
// providers/composio/client.tsと同じ「秘密情報の読み出し箇所を1つに
// 限定する」既存パターン)。この値はcore/tact-bot/adapters/slack/配下
// (署名検証境界)以外へ一切渡さない——rawなsecret文字列をverification
// utility(verifySlackSignature.ts)の引数として1回だけ渡し、それ以外の
// module(normalizeSlackEvent.ts・handleSlackWebhookRequest.ts本体・
// core/tact-bot/gateway/receiveMessage.ts等)は一切参照しない。
//
// SLACK_BOT_TOKENはS1aでは扱わない(outbound chat.postMessageは
// S1c以降のscope)。

export function getSlackSigningSecret(): string | undefined {

  const value = process.env.SLACK_SIGNING_SECRET;

  return typeof value === "string" && value.length > 0 ? value : undefined;

}
