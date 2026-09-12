import type { ContextResolutionResult } from "../tact-context-resolution";
import type { GmailMessageSummary } from "../tact-integration";
import type { ResolvedWorkIntent } from "./types";
// REF-P1e: 型のみ再利用(既存canonical、core/tact-referent/types.tsで
// 確立済み)。proposeGmailReply()自体はこのphaseで一切変更しない
// ——sourceReferentは常にundefinedのまま生成され続ける(絶対条件:
// live orchestration挙動を変えない)。この型に追加するのは、将来
// (REF-P1f)のResolver/Clarification配線がsourceReferentを持つ
// proposalを生成できるようにする、dormantな受け皿のみ。
import type { SourceReferentSnapshot } from "../tact-referent/types";

export interface GmailReplyProposal {
  action: {
    service: "gmail";
    operation: "send_message";
    input: { to: string[]; subject: string; bodyText: string };
  };
  reason: string;
  sourceMessageRef: string;
  // REF-P1e: optional。proposeGmailReply()は現時点で一切設定しない
  // (P1f以降、Resolver/Clarificationが選択したcandidateから
  // buildSourceReferentSnapshot()経由で設定する想定の、dormant field)。
  sourceReferent?: SourceReferentSnapshot;
}

const MAX_DRAFT_BODY_LENGTH = 2_000;

function parseSingleAddress(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const matched = from.match(/<([^<>\s,;]+@[^<>\s,;]+)>/u)?.[1] ?? from.trim();
  return /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/u.test(matched)
    ? matched.toLowerCase()
    : undefined;
}

function parseGmailMessages(result: ContextResolutionResult): GmailMessageSummary[] {
  // ContextPack deliberately strips raw Gmail payloads. The proposal receives
  // only the canonical search result exposed to the resolution boundary.
  const outcome = result.rawGmailSearch;
  return outcome?.messages ?? [];
}

function replySubject(subject: string | undefined): string | undefined {
  const normalized = subject?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return /^re:/iu.test(normalized) ? normalized : `Re: ${normalized}`;
}

/**
 * Produces a deliberately conservative text-only proposal. It is not an
 * authorization decision: callers must create an Approval over `action`.
 */
export function proposeGmailReply(
  intent: ResolvedWorkIntent,
  resolution: ContextResolutionResult
): GmailReplyProposal | undefined {
  if ((intent.requestType !== "act" && intent.requestType !== "prepare") || resolution.sources.gmail !== "available") return undefined;
  const messages = parseGmailMessages(resolution);
  if (messages.length !== 1) return undefined;
  const message = messages[0];
  const to = parseSingleAddress(message.from);
  const subject = replySubject(message.subject);
  if (!to || !subject) return undefined;

  const bodyText = [
    "お世話になっております。",
    "ご連絡いただいた件について確認いたしました。",
    `${intent.subject}について、内容を確認のうえ対応いたします。`,
    "よろしくお願いいたします。",
  ].join("\n\n").slice(0, MAX_DRAFT_BODY_LENGTH);

  return {
    action: { service: "gmail", operation: "send_message", input: { to: [to], subject, bodyText } },
    reason: "関連する受信メールへの返信案を作成しました。",
    sourceMessageRef: message.messageId,
  };
}

export function formatGmailReplyProposal(proposal: GmailReplyProposal): string {
  const { to, subject, bodyText } = proposal.action.input;
  return [
    "返信案を作成しました。",
    `To: ${to.join(", ")}`,
    `件名: ${subject}`,
    "本文:",
    "---",
    bodyText,
    "---",
    "この内容で送信しますか？",
  ].join("\n");
}
