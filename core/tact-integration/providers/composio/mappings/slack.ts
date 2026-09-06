import type { IntegrationAction } from "../../../types";

// =========================
// TACT Integration — Composio Slack Tool Mapping
// (Architecture Migration Phase C1)
// =========================
//
// Canonical Action(service:"slack", operation:"send_message")を、
// 現在のComposio公式Slack toolkitのTool slugへ変換する。
//
// 確認済み事実(docs.composio.dev/toolkits/slack、2026-09時点):
//   - 現行slug: "SLACK_SEND_MESSAGE"
//     (旧slug"SLACK_CHAT_POST_MESSAGE"はdeprecated——このAdapterは
//     旧slugを使わない)
//   - 必須入力: channel(投稿先のchannel ID/name・DM channel ID・
//     private group)
//   - 本文は`markdown_text`(通常のMarkdown本文用)または`blocks`
//     (Block Kit)のいずれか。`text`というfieldはschema上存在しない
//     (Phase C1.5 Live Acceptanceで実機確認、additionalProperties:
//     false)。このAdapterはCanonical input.text(プレーンテキスト)を
//     受け取り、Composioへは`markdown_text`として渡す(絶対条件:
//     巨大なIntegrationを一度に作らない。Block Kit等の高度な入力は
//     Phase C1のscope外)。
//
// 絶対条件(Phase C1指示Section7): Tool slugそのものをTACT canonical
// action identityにしない——この変換はcore/tact-integration/
// providers/composio/配下だけに閉じ込め、呼び出し元はCanonical
// Action(service/operation)だけを組み立てればよい。

export interface ComposioToolInvocation {

  slug: string;

  arguments: Record<string, unknown>;

}

export type SlackToolMappingResult =
  | { ok: true; invocation: ComposioToolInvocation }
  | { ok: false; reason: string };

const SLACK_SEND_MESSAGE_TOOL_SLUG = "SLACK_SEND_MESSAGE";

export function mapSlackActionToComposioTool(
  action: IntegrationAction
): SlackToolMappingResult {

  if (action.service !== "slack") {

    return {
      ok: false,
      reason: `mapSlackActionToComposioTool()はservice="slack"のみを扱う(渡された値: "${action.service}")`,
    };

  }

  if (action.operation !== "send_message") {

    return {
      ok: false,
      reason: `未対応のslack operation: "${action.operation}"(Phase C1ではsend_messageのみ対応)`,
    };

  }

  const { channel, text } = action.input;

  if (typeof channel !== "string" || channel.trim().length === 0) {

    return {
      ok: false,
      reason: "slack.send_messageにはstring型の非空channelが必要です",
    };

  }

  if (typeof text !== "string" || text.trim().length === 0) {

    return {
      ok: false,
      reason: "slack.send_messageにはstring型の非空textが必要です",
    };

  }

  return {

    ok: true,

    invocation: {
      slug: SLACK_SEND_MESSAGE_TOOL_SLUG,
      // Phase C1.5 Live Acceptance(実機確認)で判明: 現在Composioが
      // 実際にホストしているSlack toolkit(2026-09時点でtoolkit
      // version 20260826_00がlatest解決先)のSLACK_SEND_MESSAGE
      // schemaには`text`というfield自体が存在せず
      // (additionalProperties: false)、通常テキスト本文は
      // `markdown_text`で渡す仕様になっている(`blocks`使用時のみ
      // `fallback_text`を使う設計、Phase C1時点のPhase C1実装
      // ドキュメント作成時から仕様が変わっていた)。TACT Canonical
      // Action(service/operation/input.text)は変更せず、この
      // Provider固有のfield名変換だけをここに閉じ込める。
      arguments: { channel, markdown_text: text },
    },

  };

}
