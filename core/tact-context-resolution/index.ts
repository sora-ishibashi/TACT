import type { ConversationEvidence } from "../tact-conversation/conversationEvidence";
import type {
  GmailSearchMessagesResult,
  NotionReadPageResult,
  NotionSearchResult,
} from "../tact-integration/types";

export type ContextEvidenceCategory = "conversation" | "organizational" | "communication";
export type ContextSourceType = "slack" | "notion" | "gmail";
export type ContextSourceStatus = "available" | "no_match" | "unavailable" | "failed";

export interface ContextEvidenceItem {
  category: ContextEvidenceCategory;
  sourceType: ContextSourceType;
  sourceRef: string;
  title?: string;
  text: string;
  timestamp?: string;
  provenance: { operation?: string; sourceRef?: string };
}

export interface ContextPack {
  request: { text: string };
  subject: { queryTerms: string[]; summary?: string };
  evidence: ContextEvidenceItem[];
  metrics: { evidenceCount: number; totalChars: number; truncated: boolean };
}

export interface ContextResolutionPlan {
  kind: "ready" | "ambiguous";
  requestText: string;
  subject?: { summary: string; queryTerms: string[] };
  sources: {
    notion?: { query: string };
    gmail?: { query: string };
  };
  clarification?: string;
}

export interface ContextReadOutcome {
  service: "notion" | "gmail";
  operation: "search" | "read_page" | "search_messages";
  status: "completed" | "unavailable" | "failed";
  output?: string;
}

export interface ContextResolutionResult {
  plan: ContextResolutionPlan;
  pack: ContextPack;
  sources: Partial<Record<"notion" | "gmail", ContextSourceStatus>>;
}

const MAX_QUERY_LENGTH = 120;
const MAX_CONTEXT_PACK_CHARS = 30_000;
const MAX_SLACK_EVIDENCE_CHARS = 20_000;
const MAX_NOTION_EVIDENCE_CHARS = 6_000;
const MAX_GMAIL_EVIDENCE_CHARS = 4_000;

function normalizeText(value: string): string {
  return value.replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
}

function boundedText(value: string, maxLength: number): string {
  return normalizeText(value).slice(0, maxLength);
}

function isReferentialConfirmationRequest(value: string): boolean {
  return /(?:これ|この(?:件|内容|案件)?|状況).{0,12}(?:確認|見て)|(?:確認|見て).{0,12}(?:これ|この(?:件|内容|案件)?|状況)/u.test(value);
}

function isUnsafeInstructionLike(value: string): boolean {
  return /(?:削除|送信|返信|作成|更新|変更|実行).{0,12}(?:して|しといて|してください)/u.test(value);
}

function subjectFromConversation(evidence: ConversationEvidence): string | undefined {
  const priorMessages = evidence.messages.filter(
    (message) => message.relationship !== "trigger" && !isUnsafeInstructionLike(message.text)
  );

  const candidates = priorMessages
    .map((message, index) => {
      const candidate = boundedText(message.text.split(/[、。！？!?]/u)[0] ?? "", MAX_QUERY_LENGTH)
        .replace(/(?:について)?(?:確認(?:お願い)?|を|は|が|だよね|お願い)$/u, "")
        .trim();
      const topicSignal = /(?:案件|プロジェクト|契約|更新|期限|担当|顧客|社内|ページ)/u.test(candidate) ? 20 : 0;
      const communicationOnlyPenalty = /(?:メール|gmail|e-mail|mail|受信|来てた)/iu.test(candidate) ? 10 : 0;
      // Earlier conversational anchors win ties over a later observation.
      return { candidate, score: topicSignal - communicationOnlyPenalty - index / 100 };
    })
    .filter((candidate) => candidate.candidate.length >= 3 && candidate.score >= 10)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.candidate;
}

function queryTermsForSubject(subject: string): string[] {
  const normalized = boundedText(subject, MAX_QUERY_LENGTH);
  const terms = new Set<string>([normalized]);
  const firstSegment = normalized.split(/(?:の|\s+)/u)[0]?.trim();
  if (firstSegment && firstSegment.length >= 2) {
    terms.add(firstSegment);
  }
  return [...terms].slice(0, 3);
}

function mentionsCommunication(evidence: ConversationEvidence, requestText: string): boolean {
  const text = `${requestText}\n${evidence.messages.map((message) => message.text).join("\n")}`;
  return /(?:メール|gmail|e-mail|mail|受信|先方から)/iu.test(text);
}

/**
 * This deliberately small planner is only enabled for a referential Slack
 * confirmation. It derives a bounded subject from recent evidence; it never
 * interprets any prior message as an executable instruction.
 */
export function planContextResolution(
  requestText: string,
  conversationEvidence: ConversationEvidence | undefined
): ContextResolutionPlan | undefined {
  if (!conversationEvidence || !isReferentialConfirmationRequest(requestText)) {
    return undefined;
  }

  const subject = subjectFromConversation(conversationEvidence);
  if (!subject) {
    return {
      kind: "ambiguous",
      requestText,
      sources: {},
      clarification: "どの案件を指しているか特定できませんでした。もう少し対象が分かる情報を教えてください。",
    };
  }

  const queryTerms = queryTermsForSubject(subject);
  const gmailQuery = queryTerms[1] ?? queryTerms[0];

  return {
    kind: "ready",
    requestText,
    subject: { summary: subject, queryTerms },
    // Organizational evidence is useful for a bounded, identifiable work
    // subject. Communication is selected only when the trigger/evidence asks
    // about mail or another communication signal.
    sources: {
      notion: { query: queryTerms[0] },
      ...(mentionsCommunication(conversationEvidence, requestText)
        ? { gmail: { query: gmailQuery } }
        : {}),
    },
  };
}

function parseOutput<T>(outcome: ContextReadOutcome, guard: (value: unknown) => value is T): T | undefined {
  if (outcome.status !== "completed" || !outcome.output) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(outcome.output);
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isNotionSearch(value: unknown): value is NotionSearchResult {
  return !!value && typeof value === "object" && Array.isArray((value as NotionSearchResult).results);
}

function isNotionRead(value: unknown): value is NotionReadPageResult {
  return !!value && typeof value === "object" && typeof (value as NotionReadPageResult).pageId === "string" && typeof (value as NotionReadPageResult).text === "string";
}

function isGmailSearch(value: unknown): value is GmailSearchMessagesResult {
  return !!value && typeof value === "object" && Array.isArray((value as GmailSearchMessagesResult).messages);
}

function sourceStatus(outcomes: ContextReadOutcome[], service: "notion" | "gmail", matched: boolean): ContextSourceStatus | undefined {
  const relevant = outcomes.filter((outcome) => outcome.service === service);
  if (relevant.length === 0) return undefined;
  if (relevant.some((outcome) => outcome.status === "unavailable")) return "unavailable";
  if (relevant.some((outcome) => outcome.status === "failed")) return "failed";
  return matched ? "available" : "no_match";
}

function truncateEvidence(items: ContextEvidenceItem[]): Pick<ContextPack, "evidence" | "metrics"> {
  let totalChars = 0;
  let truncated = false;
  const evidence: ContextEvidenceItem[] = [];
  for (const item of items) {
    const remaining = MAX_CONTEXT_PACK_CHARS - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = item.text.slice(0, remaining);
    if (text.length < item.text.length) truncated = true;
    if (!text) continue;
    evidence.push({ ...item, text });
    totalChars += text.length;
  }
  return { evidence, metrics: { evidenceCount: evidence.length, totalChars, truncated } };
}

export function buildContextResolutionResult(
  plan: ContextResolutionPlan,
  conversationEvidence: ConversationEvidence | undefined,
  outcomes: ContextReadOutcome[]
): ContextResolutionResult {
  const items: ContextEvidenceItem[] = [];

  if (conversationEvidence) {
    let remainingSlackChars = MAX_SLACK_EVIDENCE_CHARS;
    for (const message of conversationEvidence.messages) {
      if (remainingSlackChars <= 0) break;
      const text = boundedText(message.text, remainingSlackChars);
      if (!text) continue;
      items.push({
        category: "conversation",
        sourceType: "slack",
        sourceRef: message.messageRef,
        text,
        timestamp: message.timestamp,
        provenance: { sourceRef: conversationEvidence.sourceRef },
      });
      remainingSlackChars -= text.length;
    }
  }

  const notionRead = outcomes
    .filter((outcome) => outcome.service === "notion" && outcome.operation === "read_page")
    .map((outcome) => parseOutput(outcome, isNotionRead))
    .find((result): result is NotionReadPageResult => !!result);
  const notionSearch = outcomes
    .filter((outcome) => outcome.service === "notion" && outcome.operation === "search")
    .map((outcome) => parseOutput(outcome, isNotionSearch))
    .find((result): result is NotionSearchResult => !!result);

  if (notionRead) {
    items.push({
      category: "organizational",
      sourceType: "notion",
      sourceRef: notionRead.pageId,
      ...(notionRead.title ? { title: notionRead.title } : {}),
      text: boundedText(notionRead.text, MAX_NOTION_EVIDENCE_CHARS),
      ...(notionRead.lastEditedTime ? { timestamp: notionRead.lastEditedTime } : {}),
      provenance: { operation: "read_page", sourceRef: notionRead.pageId },
    });
  } else if (notionSearch?.results.length) {
    for (const result of notionSearch.results.slice(0, 3)) {
      items.push({
        category: "organizational",
        sourceType: "notion",
        sourceRef: result.id,
        title: result.title,
        text: result.title,
        ...(result.lastEditedTime ? { timestamp: result.lastEditedTime } : {}),
        provenance: { operation: "search", sourceRef: result.id },
      });
    }
  }

  const gmailSearch = outcomes
    .filter((outcome) => outcome.service === "gmail" && outcome.operation === "search_messages")
    .map((outcome) => parseOutput(outcome, isGmailSearch))
    .find((result): result is GmailSearchMessagesResult => !!result);
  if (gmailSearch) {
    let remainingGmailChars = MAX_GMAIL_EVIDENCE_CHARS;
    for (const message of gmailSearch.messages.slice(0, 10)) {
      const text = boundedText(message.bodyText ?? message.snippet ?? message.subject ?? "", remainingGmailChars);
      if (!text) continue;
      items.push({
        category: "communication",
        sourceType: "gmail",
        sourceRef: message.messageId,
        ...(message.subject ? { title: message.subject } : {}),
        text,
        ...(message.date ? { timestamp: message.date } : {}),
        provenance: { operation: "search_messages", sourceRef: message.messageId },
      });
      remainingGmailChars -= text.length;
      if (remainingGmailChars <= 0) break;
    }
  }

  const { evidence, metrics } = truncateEvidence(items);
  const hasNotionEvidence = evidence.some((item) => item.sourceType === "notion");
  const hasGmailEvidence = evidence.some((item) => item.sourceType === "gmail");
  return {
    plan,
    pack: {
      request: { text: plan.requestText },
      subject: plan.subject ?? { queryTerms: [] },
      evidence,
      metrics,
    },
    sources: {
      // A planned source with no normalized execution outcome is not proof of
      // a negative result. Keep the existing no_match semantics only for a
      // completed provider attempt; fail closed for an absent outcome.
      ...(plan.sources.notion ? { notion: sourceStatus(outcomes, "notion", hasNotionEvidence) ?? "failed" } : {}),
      ...(plan.sources.gmail ? { gmail: sourceStatus(outcomes, "gmail", hasGmailEvidence) ?? "failed" } : {}),
    },
  };
}

export function formatContextResolutionAnswer(result: ContextResolutionResult): string {
  if (result.plan.kind === "ambiguous") {
    return result.plan.clarification ?? "対象を特定できませんでした。もう少し情報を教えてください。";
  }

  const subject = result.plan.subject?.summary ?? "この案件";
  const lines = [`${subject}について確認しました。`];
  const notion = result.pack.evidence.filter((item) => item.sourceType === "notion");
  const gmail = result.pack.evidence.filter((item) => item.sourceType === "gmail");

  if (result.sources.notion === "unavailable") {
    lines.push("Notionが未接続のため、社内情報は確認できませんでした。");
  } else if (result.sources.notion === "failed") {
    lines.push("Notionの確認は完了できませんでした。");
  } else if (notion.length === 0) {
    lines.push("Notionでは該当する情報を確認できませんでした。");
  } else {
    const page = notion.find((item) => item.provenance.operation === "read_page") ?? notion[0];
    lines.push(`Notion上では${page.title ? `「${page.title}」を` : "該当情報を"}確認しました。`);
    lines.push(page.text.slice(0, 1_200));
  }

  if (result.plan.sources.gmail) {
    if (result.sources.gmail === "unavailable") {
      lines.push("Gmailが未接続のため、先方メールまでは確認できませんでした。");
    } else if (result.sources.gmail === "failed") {
      lines.push("Gmailの確認は完了できませんでした。");
    } else if (gmail.length === 0) {
      lines.push("Gmailでは該当するメールは確認できませんでした。");
    } else {
      lines.push(`Gmailで該当するメールを${gmail.length}件確認しました。`);
      for (const message of gmail.slice(0, 3)) {
        lines.push(`・${message.title ?? "件名なし"}${message.timestamp ? `（${message.timestamp}）` : ""}`);
      }
    }
  }

  return lines.filter(Boolean).join("\n");
}
