// =========================
// TACT Canonical Execution — Slack Web API Call Adapter (SOR-130 Reality Test)
// =========================
//
// 既存のnormalizeSlackExecutionEvent.tsは「Slack側で既に完結した
// actionをTACTが事後発見する」reconciled経路(inbound webhook)のみを
// 扱う。このfileはその逆方向——TACT自身がSlack Web APIを直接呼び出す
// instrumented経路(例: chat.postMessageでのSEND)——を扱う、もう一つの
// 小さなSlack adapter。既存adapterを変更せず、新しいfileとして追加する
// だけ(絶対条件: 既存のNotion/Slack経路を壊さない)。
//
// message本文(text)はsource_metadataへ含めない(既存adapterと同じ
// 絶対条件)。

import type { CaptureExecutionInput } from "../../types";
import type { ExecutionAdapterNormalizeResult } from "../types";

export const SLACK_WEB_API_ADAPTER_VERSION = "slack-web-api-v1";

export type SlackWebApiCanonicalOperation = "AUTH_TEST" | "CHAT_POST_MESSAGE";

export type SlackWebApiSafeErrorCode =
  | "slack_api_call_failed"
  | "slack_rate_limited"
  | "slack_channel_not_found"
  | "slack_permission_denied";

const SLACK_WEB_API_SAFE_ERROR_CODES: readonly SlackWebApiSafeErrorCode[] = [
  "slack_api_call_failed",
  "slack_rate_limited",
  "slack_channel_not_found",
  "slack_permission_denied",
];

export interface SlackWebApiInvocationObservation {
  userId: string;
  agentId?: string | null;
  connectionId?: string | null;
  /** SOR-130絶対条件: legitimateなcarrierが無い限りnull。 */
  workId?: string | null;
  /** Idempotency key for captureExecution(). */
  invocationId: string;
  operation: SlackWebApiCanonicalOperation;
  /** The bot's own Slack user id, when known from the API response (auth.test). Never fabricated. */
  botUserId?: string | null;
  teamId?: string | null;
  channel?: string | null;
  /** The posted message's `ts`, when CHAT_POST_MESSAGE succeeded. */
  messageTs?: string | null;
  status: "succeeded" | "failed";
  errorCode?: SlackWebApiSafeErrorCode | null;
  providerOccurredAt?: string | null;
  observedAt?: string;
}

function boundedString(value: string | null | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\u0000/gu, "").trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function operationFields(operation: SlackWebApiCanonicalOperation): {
  actionCategory: CaptureExecutionInput["actionCategory"];
  operation: string;
  resourceType: string;
} {
  switch (operation) {
    case "AUTH_TEST":
      return { actionCategory: "read", operation: "slack_auth_test", resourceType: "slack_workspace" };
    case "CHAT_POST_MESSAGE":
      return { actionCategory: "send", operation: "slack_chat_post_message", resourceType: "slack_message" };
  }
}

function safeErrorCode(value: unknown): SlackWebApiSafeErrorCode {
  return typeof value === "string" && SLACK_WEB_API_SAFE_ERROR_CODES.includes(value as SlackWebApiSafeErrorCode)
    ? value as SlackWebApiSafeErrorCode
    : "slack_api_call_failed";
}

export function normalizeSlackWebApiInvocationToExecution(
  observation: SlackWebApiInvocationObservation
): ExecutionAdapterNormalizeResult {
  const invocationId = boundedString(observation.invocationId, 500);

  if (!invocationId) {
    return { ok: false, reason: "missing invocationId" };
  }

  const fields = operationFields(observation.operation);
  const teamId = boundedString(observation.teamId, 255);
  const channel = boundedString(observation.channel, 255);
  const messageTs = boundedString(observation.messageTs, 255);

  const resourceIdentifier =
    observation.operation === "CHAT_POST_MESSAGE" && teamId && channel && messageTs
      ? `${teamId}:${channel}:${messageTs}`
      : teamId ?? null;

  return {
    ok: true,
    input: {
      userId: observation.userId,
      workId: boundedString(observation.workId, 255) ?? null,
      connectionId: boundedString(observation.connectionId, 255) ?? null,
      // Slack Web APIの直接呼び出しはTACT自身の(人間の代理ではない)
      // service actionとして扱う。principal(=Bot自身)の識別は
      // botUserId(既知の場合のみ)で表す。
      actorKind: "service",
      actorId: boundedString(observation.botUserId, 255) ?? null,
      agentId: boundedString(observation.agentId, 255) ?? null,
      provider: "slack",
      targetProvider: "slack",
      sourceType: "sdk_callback",
      externalEventId: invocationId,
      adapterVersion: SLACK_WEB_API_ADAPTER_VERSION,
      sourceMetadata: (teamId || channel) ? { teamId: teamId ?? null, channel: channel ?? null } : null,
      // TACT自身がSlack Web APIを直接呼び出し、計装している(instrumented)。
      // 既存adapterのreconciled(inbound webhook)とは異なる経路であることを
      // 明示する。
      observationMode: "instrumented",
      actionCategory: fields.actionCategory,
      operation: fields.operation,
      resourceType: fields.resourceType,
      resourceIdentifier,
      status: observation.status,
      ...(observation.status === "failed"
        ? {
            errorCode: safeErrorCode(observation.errorCode),
            errorMessage: "Slack Web API call failed",
          }
        : {}),
      providerOccurredAt: observation.providerOccurredAt ?? null,
      observedAt: observation.observedAt,
    },
  };
}
