import type { IntegrationAction, SlackChannelSummary, SlackListChannelsResult } from "../../../types";

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

// Architecture Migration Phase C2.2a(schema verification、live Composio
// metadata APIで一次確認済み)確認済み事実:
//   - exact tool slug: "SLACK_LIST_ALL_CHANNELS"
//     (toolkit version 20260826_00、@composio/core@0.18.1、
//     composio.tools.getRawComposioToolBySlug()で直接確認)
//   - read-only・idempotent(tags: readOnlyHint/idempotentHint、
//     createHint/updateHint/destructiveHintはいずれも無し)
//   - 必須input無し(inputParameters.required === [])
//   - optional input: limit(1〜1000)/types/cursor/team_id/exclude_archived
//   - 絶対条件(C2.2a発見事項、最重要): limitのschema既定値は1
//     ("defaults to 1 if omitted")。canonical input `{}` をそのまま
//     渡すと1件しかchannelが返らないため、このAdapterがlimit:100を
//     provider-specific defaultとして注入する(TACT canonical input
//     へは一切追加しない——input.limitというcanonical fieldは存在
//     しない、絶対条件)。
const SLACK_LIST_ALL_CHANNELS_TOOL_SLUG = "SLACK_LIST_ALL_CHANNELS";
const SLACK_LIST_ALL_CHANNELS_DEFAULT_LIMIT = 100;

export function mapSlackActionToComposioTool(
  action: IntegrationAction
): SlackToolMappingResult {

  if (action.service !== "slack") {

    return {
      ok: false,
      reason: `mapSlackActionToComposioTool()はservice="slack"のみを扱う(渡された値: "${action.service}")`,
    };

  }

  // Architecture Migration Phase C2.2b: list_channels(read)。canonical
  // input(絶対条件: `{}` のまま、limit等のprovider都合fieldをcanonical
  // inputへ一切追加しない)を、Provider Adapter都合のdefault
  // (limit:100)だけを注入したComposio argumentsへ変換する。types/
  // cursor/team_id/exclude_archivedはprovider既定挙動のまま(絶対条件:
  // C2.2ではcanonical semanticsを勝手に拡張しない——public+privateの
  // 明示指定やarchived除外の明示指定もしない)。
  if (action.operation === "list_channels") {

    return {

      ok: true,

      invocation: {
        slug: SLACK_LIST_ALL_CHANNELS_TOOL_SLUG,
        arguments: { limit: SLACK_LIST_ALL_CHANNELS_DEFAULT_LIMIT },
      },

    };

  }

  if (action.operation !== "send_message") {

    return {
      ok: false,
      reason: `未対応のslack operation: "${action.operation}"(send_message/list_channels以外は未対応)`,
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

// =========================
// mapComposioListChannelsResultToCanonical
// (Architecture Migration Phase C2.2b)
// =========================
//
// Composio SLACK_LIST_ALL_CHANNELSのraw response(C2.2aで一次確認済み
// のschema: {data: {ok, channels: ChannelItem[], response_metadata},
// successful, ...}のうちdata部分)を、core/tact-integration/execution.ts
// のcanonical outputへ渡してよい最小shape(SlackListChannelsResult)へ
// 変換する。絶対条件(Section8): raw provider response(Composio/Slack
// 固有のfield)をcanonical domainへ一切漏らさない——保持するのは
// id/name/isPrivateのみ。
export type SlackListChannelsMappingResult =
  | { ok: true; result: SlackListChannelsResult }
  | { ok: false; reason: string };

export function mapComposioListChannelsResultToCanonical(
  rawData: unknown
): SlackListChannelsMappingResult {

  if (!rawData || typeof rawData !== "object") {

    return {
      ok: false,
      reason: "Composio list_channels responseのdataが想定外の形式です(objectではありません)",
    };

  }

  const data = rawData as { ok?: unknown; channels?: unknown };

  // Slack API自体のsuccess flag(Composio SDK自身のresult.successfulとは
  // 別レイヤー、C2.2a確認済みschema「data.ok」)。ComposioがSDKレベルで
  // successful:trueを返していても、Slack側がok:falseで論理エラーを
  // 返している場合は安全に失敗として扱う(絶対条件Section7)。
  if (data.ok !== true) {

    return {
      ok: false,
      reason: "Slack API(data.ok)がtrueを返しませんでした",
    };

  }

  if (!Array.isArray(data.channels)) {

    return {
      ok: false,
      reason: "channelsがarrayではありません(provider schema契約違反)",
    };

  }

  const channels: SlackChannelSummary[] = [];

  for (const rawChannel of data.channels) {

    if (!rawChannel || typeof rawChannel !== "object") {

      // 絶対条件(Section7、ユーザー指示): channel item単位でschema
      // 契約違反が見つかった場合、該当itemだけを黙ってdropせず、
      // result全体をinvalidとして安全側(strict failure)へ倒す
      // ——provider schema corruptionを隠すより、canonical boundary
      // では明示的な失敗を優先する(既存extractIntegrationAction
      // FromApproval()等、repository全体で一貫している「部分的にでは
      // なく丸ごと安全側へ倒す」防御パターンを踏襲)。
      return {
        ok: false,
        reason: "channel itemが想定外の形式です(objectではありません)",
      };

    }

    const { id, name, is_private: isPrivate } = rawChannel as Record<string, unknown>;

    // C2.2aで確認済み: ChannelItem.required = ["id", "created"]。id は
    // schema上必ずstringのはず——非string/空文字は契約違反として
    // result全体をinvalidにする(dropではなくfail、理由は上記コメント
    // と同じ)。
    if (typeof id !== "string" || id.length === 0) {

      return {
        ok: false,
        reason: "channel.idがstring型ではありません(provider schema契約違反)",
      };

    }

    channels.push({

      id,

      // name/isPrivateはC2.2aで確認済みの通りschema上optional
      // (「Not present for DM channels」)。存在しない場合はcanonical
      // itemへ`undefined`をキーとして持たせず、fieldごと省略する。
      ...(typeof name === "string" ? { name } : {}),

      ...(typeof isPrivate === "boolean" ? { isPrivate } : {}),

    });

  }

  return { ok: true, result: { channels } };

}
