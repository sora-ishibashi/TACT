import type {
  ConversationAttachmentReference,
  ConversationEvidence,
  ConversationEvidenceMessage,
} from "../../../tact-conversation/conversationEvidence";
import type { ConversationIntakeStage } from "../../../tact-diagnostics/conversationIntakeStage";

export const SLACK_THREAD_CONTEXT_MAX_MESSAGES = 15;
export const SLACK_CHANNEL_CONTEXT_MAX_PRECEDING_MESSAGES = 8;
export const SLACK_CONTEXT_MAX_TEXT_CHARS = 20_000;
export const SLACK_CONTEXT_LOOKBACK_SECONDS = 30 * 60;

export interface SlackContextFile {
  id?: string;
  name?: string;
  mimetype?: string;
}

export interface SlackContextSourceMessage {
  ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackContextFile[];
}

export interface SlackConversationContextApi {
  getThreadReplies(params: { channel: string; ts: string; latest: string; limit: number }): Promise<SlackConversationContextResponse>;
  getChannelHistory(params: { channel: string; latest: string; limit: number }): Promise<SlackConversationContextResponse>;
}

export interface SlackConversationContextResponse {
  ok: boolean;
  messages: SlackContextSourceMessage[];
  // The Slack client already falls back to ok:false. Retaining the thrown
  // value here lets the caller emit a redacted, operation-specific diagnostic
  // without changing that fallback behavior.
  error?: unknown;
}

export type SlackConversationRetrievalOperation =
  | "conversations.history"
  | "conversations.replies";

export interface SlackConversationContextTrigger {
  channelRef: string;
  triggerMessageRef: string;
  triggerAuthorRef: string;
  triggerText: string;
  triggerTimestamp: string;
  threadRef?: string;
}

function timestampNumber(timestamp: string): number {
  const value = Number(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function toAttachment(file: SlackContextFile): ConversationAttachmentReference | undefined {
  if (!file.id) return undefined;
  const type = file.mimetype ?? "";
  const kind = type.startsWith("image/") ? "image"
    : type === "application/pdf" ? "pdf"
    : /(word|excel|powerpoint|officedocument)/i.test(type) ? "office"
    : type.startsWith("text/") ? "text" : "other";
  return { sourceRef: file.id, ...(file.name ? { filename: file.name } : {}), ...(file.mimetype ? { mimeType: file.mimetype } : {}), kind };
}

function normalizeSourceMessage(
  source: SlackContextSourceMessage,
  relationship: ConversationEvidenceMessage["relationship"],
  tactBotUserId?: string
): ConversationEvidenceMessage | undefined {
  if (!source.ts || !source.text?.trim() || source.subtype) return undefined;
  // Do not discard all bots: only a configured TACT bot identity is filtered.
  if (tactBotUserId && source.user === tactBotUserId) return undefined;
  const attachments = (source.files ?? []).map(toAttachment).filter((item): item is ConversationAttachmentReference => Boolean(item));
  return {
    messageRef: source.ts,
    ...(source.user ? { authorRef: source.user } : {}),
    text: source.text.trim(),
    timestamp: source.ts,
    relationship,
    ...(attachments.length ? { attachments } : {}),
  };
}

function triggerMessage(trigger: SlackConversationContextTrigger): ConversationEvidenceMessage {
  return {
    messageRef: trigger.triggerMessageRef,
    authorRef: trigger.triggerAuthorRef,
    text: trigger.triggerText,
    timestamp: trigger.triggerTimestamp,
    relationship: "trigger",
  };
}

function boundMessages(messages: ConversationEvidenceMessage[]): { messages: ConversationEvidenceMessage[]; truncated: boolean } {
  const unique = new Map<string, ConversationEvidenceMessage>();
  for (const message of messages) unique.set(message.messageRef, message);
  const chronological = [...unique.values()].sort((a, b) => timestampNumber(a.timestamp) - timestampNumber(b.timestamp));
  const root = chronological.find((message) => message.relationship === "thread_root");
  const trigger = chronological.find((message) => message.relationship === "trigger");
  const priority = [...(root ? [root] : []), ...chronological.filter((message) => message !== root && message !== trigger).reverse(), ...(trigger ? [trigger] : [])];
  let remaining = SLACK_CONTEXT_MAX_TEXT_CHARS;
  const selected = new Map<string, ConversationEvidenceMessage>();
  let truncated = false;
  for (const message of priority) {
    if (remaining <= 0) { truncated = true; continue; }
    const text = message.text.length > remaining ? message.text.slice(0, remaining) : message.text;
    if (text.length !== message.text.length) truncated = true;
    remaining -= text.length;
    selected.set(message.messageRef, text === message.text ? message : { ...message, text });
  }
  if (selected.size < chronological.length) truncated = true;
  return { messages: [...selected.values()].sort((a, b) => timestampNumber(a.timestamp) - timestampNumber(b.timestamp)), truncated };
}

function buildEvidence(
  trigger: SlackConversationContextTrigger,
  mode: ConversationEvidence["provenance"]["retrievalMode"],
  candidates: ConversationEvidenceMessage[],
  retrievedMessageCount: number,
  retrievalFailed: boolean
): ConversationEvidence {
  const bounded = boundMessages(candidates);
  return {
    sourceType: "slack",
    sourceRef: trigger.channelRef,
    channelRef: trigger.channelRef,
    ...(trigger.threadRef ? { threadRef: trigger.threadRef } : {}),
    messages: bounded.messages,
    retrievedAt: new Date().toISOString(),
    provenance: { triggerMessageRef: trigger.triggerMessageRef, retrievalMode: mode },
    metrics: {
      retrievedMessageCount,
      includedMessageCount: bounded.messages.length,
      normalizedCharCount: bounded.messages.reduce((sum, message) => sum + message.text.length, 0),
      attachmentCount: bounded.messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
      truncated: bounded.truncated,
      retrievalFailed,
    },
  };
}

export function triggerOnlySlackConversationEvidence(trigger: SlackConversationContextTrigger, retrievalFailed = false): ConversationEvidence {
  return buildEvidence(trigger, "trigger_only", [triggerMessage(trigger)], 0, retrievalFailed);
}

export async function retrieveSlackConversationContext(
  trigger: SlackConversationContextTrigger,
  api: SlackConversationContextApi | null,
  options: {
    tactBotUserId?: string;
    now?: () => Date;
    onRetrievalFailure?: (failure: {
      stage: ConversationIntakeStage;
      operation: SlackConversationRetrievalOperation;
      error: unknown;
    }) => void;
  } = {}
): Promise<ConversationEvidence> {
  if (!api) return triggerOnlySlackConversationEvidence(trigger, true);
  try {
    if (trigger.threadRef) {
      const response = await api.getThreadReplies({ channel: trigger.channelRef, ts: trigger.threadRef, latest: trigger.triggerTimestamp, limit: SLACK_THREAD_CONTEXT_MAX_MESSAGES });
      if (!response.ok) {
        reportRetrievalFailure(options, "conversations.replies", response.error);
        return triggerOnlySlackConversationEvidence(trigger, true);
      }
      const messages = response.messages
        .filter((message) => timestampNumber(message.ts ?? "") <= timestampNumber(trigger.triggerTimestamp))
        .map((message) => normalizeSourceMessage(message, message.ts === trigger.threadRef ? "thread_root" : "prior_thread_reply", options.tactBotUserId))
        .filter((message): message is ConversationEvidenceMessage => Boolean(message));
      messages.push(triggerMessage(trigger));
      return buildEvidence(trigger, "thread", messages, response.messages.length, false);
    }
    const response = await api.getChannelHistory({ channel: trigger.channelRef, latest: trigger.triggerTimestamp, limit: SLACK_CHANNEL_CONTEXT_MAX_PRECEDING_MESSAGES });
    if (!response.ok) {
      reportRetrievalFailure(options, "conversations.history", response.error);
      return triggerOnlySlackConversationEvidence(trigger, true);
    }
    const earliest = timestampNumber(trigger.triggerTimestamp) - SLACK_CONTEXT_LOOKBACK_SECONDS;
    const messages = response.messages
      .filter((message) => {
        const timestamp = timestampNumber(message.ts ?? "");
        return timestamp < timestampNumber(trigger.triggerTimestamp) && timestamp >= earliest;
      })
      .map((message) => normalizeSourceMessage(message, "prior_channel_message", options.tactBotUserId))
      .filter((message): message is ConversationEvidenceMessage => Boolean(message));
    messages.push(triggerMessage(trigger));
    return buildEvidence(trigger, "surrounding_messages", messages, response.messages.length, false);
  } catch (error) {
    reportRetrievalFailure(
      options,
      trigger.threadRef ? "conversations.replies" : "conversations.history",
      error
    );
    return triggerOnlySlackConversationEvidence(trigger, true);
  }
}

function reportRetrievalFailure(
  options: {
    onRetrievalFailure?: (failure: {
      stage: ConversationIntakeStage;
      operation: SlackConversationRetrievalOperation;
      error: unknown;
    }) => void;
  },
  operation: SlackConversationRetrievalOperation,
  error: unknown
): void {
  if (error === undefined) return;
  try {
    options.onRetrievalFailure?.({
      stage: operation === "conversations.replies"
        ? "conversation_intake.slack_thread"
        : "conversation_intake.slack_history",
      operation,
      error,
    });
  } catch {
    // Diagnostics must not alter the existing trigger-only fallback.
  }
}
