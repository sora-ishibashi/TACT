// Provider-independent, per-turn conversational evidence.  This is deliberately
// not a persisted Slack mirror: callers retain it only for the trusted turn that
// requested it.
export type ConversationEvidenceRelationship =
  | "thread_root"
  | "prior_thread_reply"
  | "trigger"
  | "prior_channel_message";

export interface ConversationAttachmentReference {
  sourceRef: string;
  filename?: string;
  mimeType?: string;
  kind: "image" | "pdf" | "office" | "text" | "other";
}

export interface ConversationEvidenceMessage {
  messageRef: string;
  authorRef?: string;
  text: string;
  timestamp: string;
  relationship: ConversationEvidenceRelationship;
  attachments?: ConversationAttachmentReference[];
}

export interface ConversationEvidence {
  sourceType: "slack";
  sourceRef: string;
  channelRef: string;
  threadRef?: string;
  messages: ConversationEvidenceMessage[];
  retrievedAt: string;
  provenance: {
    triggerMessageRef: string;
    retrievalMode: "thread" | "surrounding_messages" | "trigger_only";
  };
  metrics: {
    retrievedMessageCount: number;
    includedMessageCount: number;
    normalizedCharCount: number;
    attachmentCount: number;
    truncated: boolean;
    retrievalFailed: boolean;
  };
}

// This is a temporary deterministic acceptance response for CONTEXT-P1. It
// reports evidence as evidence; it neither derives an action nor treats any
// prior message as an instruction.
export function formatConversationEvidenceAcknowledgement(
  currentRequest: string,
  evidence: ConversationEvidence
): string | undefined {
  if (!/(これ|この(?:件|内容)|確認)/u.test(currentRequest)) return undefined;
  const prior = evidence.messages
    .filter((message) => message.relationship !== "trigger")
    .slice(-2)
    .map((message) => message.text.replace(/\s+/gu, " ").slice(0, 100));
  if (prior.length === 0) return undefined;
  return `直前のSlack会話（${prior.length}件）を文脈として受け取りました。会話の要点: ${prior.join(" / ")}。現在の依頼「${currentRequest.trim().slice(0, 80)}」として確認します。`;
}
