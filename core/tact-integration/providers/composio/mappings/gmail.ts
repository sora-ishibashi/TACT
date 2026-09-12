import type {
  GmailSendMessageResult,
  GmailMessageSummary,
  GmailSearchMessagesResult,
  IntegrationAction,
} from "../../../types";
import type { ComposioToolInvocation } from "./slack";

// This is the exact read-only Gmail tool exposed by the installed Composio
// SDK/API catalog (GMAIL_FETCH_EMAILS).  The canonical operation deliberately
// stays provider-neutral: gmail.search_messages.
export const GMAIL_FETCH_EMAILS_TOOL_SLUG = "GMAIL_FETCH_EMAILS";
// Verified against the installed Composio catalog and current Composio Gmail
// documentation.  The adapter uses only its text-mail subset.
export const GMAIL_SEND_EMAIL_TOOL_SLUG = "GMAIL_SEND_EMAIL";
export const GMAIL_SEARCH_DEFAULT_MAX_RESULTS = 10;
export const GMAIL_SEARCH_MAX_RESULTS = 20;
export const GMAIL_SEARCH_MAX_QUERY_LENGTH = 200;
export const GMAIL_MESSAGE_BODY_MAX_LENGTH = 4_000;
export const GMAIL_SEND_MAX_RECIPIENTS = 10;
export const GMAIL_SEND_MAX_SUBJECT_LENGTH = 300;
export const GMAIL_SEND_MAX_BODY_LENGTH = 12_000;

export type GmailToolMappingResult =
  | { ok: true; invocation: ComposioToolInvocation }
  | { ok: false; reason: string };

function validatedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  // This intentionally accepts only a single bare address. Display-name and
  // comma-separated forms are parsed before TACT constructs canonical input.
  if (!/^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/u.test(normalized)) return undefined;
  return normalized.slice(0, 320);
}

function validatedRecipients(value: unknown, field: string):
  | { ok: true; recipients: string[] }
  | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > GMAIL_SEND_MAX_RECIPIENTS) {
    return { ok: false, reason: `${field} must contain from 1 to ${GMAIL_SEND_MAX_RECIPIENTS} recipients` };
  }
  const recipients = value.map(validatedEmail);
  if (recipients.some((recipient) => !recipient)) return { ok: false, reason: `${field} contains an invalid email address` };
  return { ok: true, recipients: recipients as string[] };
}

function validatedOptionalRecipients(value: unknown, field: string):
  | { ok: true; recipients?: string[] }
  | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  return validatedRecipients(value, field);
}

function validatedBoundedText(value: unknown, field: string, maximum: number):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` };
  const normalized = value.replace(/\u0000/gu, "").trim();
  if (!normalized || normalized.length > maximum) return { ok: false, reason: `${field} must be non-empty and at most ${maximum} characters` };
  return { ok: true, value: normalized };
}

function validatedOptionalReference(value: unknown, field: string):
  | { ok: true; value?: string }
  | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` };
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) return { ok: false, reason: `${field} must be non-empty and at most 200 characters` };
  return { ok: true, value: normalized };
}

function validatedSendInput(input: Record<string, unknown>):
  | { ok: true; to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyText: string; threadId?: string; inReplyToMessageId?: string }
  | { ok: false; reason: string } {
  const allowed = new Set(["to", "cc", "bcc", "subject", "bodyText", "threadId", "inReplyToMessageId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, reason: "gmail.send_message does not accept provider-specific parameters" };
  const to = validatedRecipients(input.to, "to");
  const cc = validatedOptionalRecipients(input.cc, "cc");
  const bcc = validatedOptionalRecipients(input.bcc, "bcc");
  const subject = validatedBoundedText(input.subject, "subject", GMAIL_SEND_MAX_SUBJECT_LENGTH);
  const bodyText = validatedBoundedText(input.bodyText, "bodyText", GMAIL_SEND_MAX_BODY_LENGTH);
  const threadId = validatedOptionalReference(input.threadId, "threadId");
  const inReplyToMessageId = validatedOptionalReference(input.inReplyToMessageId, "inReplyToMessageId");
  if (!to.ok) return to;
  if (!cc.ok) return cc;
  if (!bcc.ok) return bcc;
  if (!subject.ok) return subject;
  if (!bodyText.ok) return bodyText;
  if (!threadId.ok) return threadId;
  if (!inReplyToMessageId.ok) return inReplyToMessageId;
  return { ok: true, to: to.recipients, ...(cc.recipients ? { cc: cc.recipients } : {}), ...(bcc.recipients ? { bcc: bcc.recipients } : {}), subject: subject.value, bodyText: bodyText.value, ...(threadId.value ? { threadId: threadId.value } : {}), ...(inReplyToMessageId.value ? { inReplyToMessageId: inReplyToMessageId.value } : {}) };
}

function validatedSearchInput(input: Record<string, unknown>):
  | { ok: true; query: string; maxResults: number }
  | { ok: false; reason: string } {

  const keys = Object.keys(input);

  if (keys.some((key) => key !== "query" && key !== "maxResults")) {
    return { ok: false, reason: "gmail.search_messages does not accept provider-specific parameters" };
  }

  const query = input.query;

  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, reason: "gmail.search_messages requires a non-empty query" };
  }

  const normalizedQuery = query.trim().replace(/\s+/g, " ");

  if (normalizedQuery.length > GMAIL_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, reason: "gmail.search_messages query is too long" };
  }

  const requestedMaxResults = input.maxResults ?? GMAIL_SEARCH_DEFAULT_MAX_RESULTS;

  if (
    typeof requestedMaxResults !== "number" ||
    !Number.isInteger(requestedMaxResults) ||
    requestedMaxResults < 1 ||
    requestedMaxResults > GMAIL_SEARCH_MAX_RESULTS
  ) {
    return { ok: false, reason: `gmail.search_messages maxResults must be an integer from 1 to ${GMAIL_SEARCH_MAX_RESULTS}` };
  }

  return { ok: true, query: normalizedQuery, maxResults: requestedMaxResults };

}

export function mapGmailActionToComposioTool(action: IntegrationAction): GmailToolMappingResult {

  if (action.service !== "gmail") {
    return { ok: false, reason: "Unsupported Gmail canonical operation" };
  }

  if (action.operation === "send_message") {
    const input = validatedSendInput(action.input);
    if (!input.ok) return input;
    // The current verified GMAIL_SEND_EMAIL schema does not expose a stable
    // message-level reply field. Never silently drop a requested reply/thread
    // binding and send an unrelated mail instead.
    if (input.threadId || input.inReplyToMessageId) {
      return { ok: false, reason: "gmail.send_message reply/thread delivery is not supported by the verified provider action" };
    }
    return {
      ok: true,
      invocation: {
        slug: GMAIL_SEND_EMAIL_TOOL_SLUG,
        // Current Composio uses recipient_email for the first recipient and
        // extra_recipients for additional To recipients. is_html is fixed to
        // false; attachments, aliases, raw MIME and provider request IDs are
        // deliberately outside GMAIL-P1.
        arguments: {
          recipient_email: input.to[0],
          ...(input.to.length > 1 ? { extra_recipients: input.to.slice(1) } : {}),
          ...(input.cc ? { cc: input.cc } : {}),
          ...(input.bcc ? { bcc: input.bcc } : {}),
          subject: input.subject,
          body: input.bodyText,
          is_html: false,
          user_id: "me",
        },
      },
    };
  }

  if (action.operation !== "search_messages") return { ok: false, reason: "Unsupported Gmail canonical operation" };

  const input = validatedSearchInput(action.input);

  if (!input.ok) {
    return input;
  }

  return {
    ok: true,
    invocation: {
      slug: GMAIL_FETCH_EMAILS_TOOL_SLUG,
      // user_id, paging, spam/trash scope, raw payload switches, and every
      // other provider parameter are intentionally fixed or omitted here.
      arguments: {
        query: input.query,
        max_results: input.maxResults,
        user_id: "me",
        include_payload: true,
        include_spam_trash: false,
      },
    },
  };

}

export type GmailSendMappingResult =
  | { ok: true; result: GmailSendMessageResult }
  | { ok: false; reason: string };

export function mapComposioGmailSendResultToCanonical(rawData: unknown): GmailSendMappingResult {
  const data = asRecord(rawData);
  const nested = asRecord(data?.data);
  const payload = nested ?? data;
  if (!payload) return { ok: false, reason: "Gmail send response did not contain an object" };
  const messageId = boundedString(payload.id ?? payload.messageId, 200);
  const threadId = boundedString(payload.threadId ?? payload.thread_id, 200);
  // A successful tool result without an identifiable Gmail message is not a
  // confirmed send. Fail closed instead of claiming delivery.
  if (!messageId) return { ok: false, reason: "Gmail send response did not contain a message id" };
  return { ok: true, result: { sent: true, messageId, ...(threadId ? { threadId } : {}) } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {

  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

}

function boundedString(value: unknown, maxLength: number): string | undefined {

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\u0000/g, "").trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);

}

function headerValue(payload: Record<string, unknown> | undefined, name: string): string | undefined {

  const headers = Array.isArray(payload?.headers) ? payload.headers : [];

  for (const header of headers) {
    const value = asRecord(header);

    if (typeof value?.name === "string" && value.name.toLowerCase() === name.toLowerCase()) {
      return boundedString(value.value, 1_000);
    }
  }

  return undefined;

}

function decodeBase64UrlText(value: unknown): string | undefined {

  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return undefined;
  }

}

function findPlainTextBody(payload: Record<string, unknown> | undefined): string | undefined {

  if (!payload) {
    return undefined;
  }

  const mimeType = payload.mimeType;
  const body = asRecord(payload.body);

  if (mimeType === "text/plain") {
    return decodeBase64UrlText(body?.data);
  }

  const parts = Array.isArray(payload.parts) ? payload.parts : [];

  for (const part of parts) {
    const text = findPlainTextBody(asRecord(part));

    if (text) {
      return text;
    }
  }

  // Never turn HTML into text here.  It is not safe to render, and this
  // initial capability returns bodyText only when Gmail supplies text/plain.
  return undefined;

}

function extractMessages(rawData: unknown): unknown[] | undefined {

  const data = asRecord(rawData);

  if (!data) {
    return undefined;
  }

  if (Array.isArray(data.messages)) {
    return data.messages;
  }

  const nestedData = asRecord(data.data);

  if (Array.isArray(nestedData?.messages)) {
    return nestedData.messages;
  }

  return undefined;

}

export type GmailSearchMappingResult =
  | { ok: true; result: GmailSearchMessagesResult }
  | { ok: false; reason: string };

export function mapComposioGmailSearchResultToCanonical(rawData: unknown): GmailSearchMappingResult {

  const rawMessages = extractMessages(rawData);

  if (!rawMessages) {
    return { ok: false, reason: "Gmail search response did not contain a messages array" };
  }

  const messages: GmailMessageSummary[] = [];

  for (const rawMessage of rawMessages) {
    const message = asRecord(rawMessage);
    const messageId = boundedString(message?.id ?? message?.messageId, 200);

    if (!message || !messageId) {
      return { ok: false, reason: "Gmail search response contained a message without an id" };
    }

    const payload = asRecord(message.payload);
    const bodyText = boundedString(findPlainTextBody(payload), GMAIL_MESSAGE_BODY_MAX_LENGTH);

    messages.push({
      messageId,
      ...(boundedString(message.threadId, 200) ? { threadId: boundedString(message.threadId, 200) } : {}),
      ...(headerValue(payload, "Subject") ? { subject: headerValue(payload, "Subject") } : {}),
      ...(headerValue(payload, "From") ? { from: headerValue(payload, "From") } : {}),
      ...(headerValue(payload, "To") ? { to: headerValue(payload, "To") } : {}),
      ...(headerValue(payload, "Date") ? { date: headerValue(payload, "Date") } : {}),
      ...(boundedString(message.snippet ?? message.preview, 1_000)
        ? { snippet: boundedString(message.snippet ?? message.preview, 1_000) }
        : {}),
      ...(bodyText ? { bodyText } : {}),
    });
  }

  return { ok: true, result: { messages } };

}
