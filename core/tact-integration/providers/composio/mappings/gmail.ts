import type {
  GmailMessageSummary,
  GmailSearchMessagesResult,
  IntegrationAction,
} from "../../../types";
import type { ComposioToolInvocation } from "./slack";

// This is the exact read-only Gmail tool exposed by the installed Composio
// SDK/API catalog (GMAIL_FETCH_EMAILS).  The canonical operation deliberately
// stays provider-neutral: gmail.search_messages.
export const GMAIL_FETCH_EMAILS_TOOL_SLUG = "GMAIL_FETCH_EMAILS";
export const GMAIL_SEARCH_DEFAULT_MAX_RESULTS = 10;
export const GMAIL_SEARCH_MAX_RESULTS = 20;
export const GMAIL_SEARCH_MAX_QUERY_LENGTH = 200;
export const GMAIL_MESSAGE_BODY_MAX_LENGTH = 4_000;

export type GmailToolMappingResult =
  | { ok: true; invocation: ComposioToolInvocation }
  | { ok: false; reason: string };

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

  if (action.service !== "gmail" || action.operation !== "search_messages") {
    return { ok: false, reason: "Unsupported Gmail canonical operation" };
  }

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
