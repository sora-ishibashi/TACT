// =========================
// TACT Bot — Slack Outbound Config (S1c)
// =========================
//
// SLACK_BOT_TOKENの読み出しをこのfileだけに閉じ込める(既存
// config.ts(SLACK_SIGNING_SECRET専用)・core/database/
// supabaseServiceRole.ts・core/tact-integration/providers/composio/
// client.tsと同じ「秘密情報の読み出し箇所を1つに限定する」既存
// パターン)。SLACK_BOT_TOKEN(outbound、chat.postMessage用)と
// SLACK_SIGNING_SECRET(inbound、署名検証用)は責務が異なるため、
// 意図的に別fileに分離する(1つのfileへ混ぜない)。

export function getSlackBotToken(): string | undefined {

  const value = process.env.SLACK_BOT_TOKEN;

  return typeof value === "string" && value.length > 0 ? value : undefined;

}
