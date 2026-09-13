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

// proposeGmailReply()/proposeGmailReplyFromReferent()の両方で使う、
// 完全に決定論的な(捏造の無い)boilerplate本文。message本文自体は
// 一切読まない(REF-P1: SourceReferentSnapshotにbody/snippetを含めない
// のと同じ理由——body-independentな下書きであることが、Referent
// Resolutionが選んだcandidateからも安全に同じ下書きを再構築できる
// 前提を支えている)。
function buildReplyBodyText(intent: ResolvedWorkIntent): string {
  return [
    "お世話になっております。",
    "ご連絡いただいた件について確認いたしました。",
    `${intent.subject}について、内容を確認のうえ対応いたします。`,
    "よろしくお願いいたします。",
  ].join("\n\n").slice(0, MAX_DRAFT_BODY_LENGTH);
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

  return {
    action: { service: "gmail", operation: "send_message", input: { to: [to], subject, bodyText: buildReplyBodyText(intent) } },
    reason: "関連する受信メールへの返信案を作成しました。",
    sourceMessageRef: message.messageId,
  };
}

// =========================
// proposeGmailReplyFromReferent (REF-P1f)
// =========================
//
// proposeGmailReply()と同じ保守的な下書き生成ロジックを、Referent
// Resolver(core/tact-referent/resolve.ts)が選んだ勝者candidate、または
// Referent Clarificationでpinされたcandidate(core/tact-referent/
// clarification.tsのCandidateSnapshotEntry)から直接構築できるようにする
// wrapper。ContextResolutionResult.rawGmailSearch(常に「直近1回の広い
// 検索」の結果のみ)を経由しないため、狭め検索(narrow re-query)で
// 見つかったcandidateや、Clarification回答時点で(TOCTOU-safeに)
// pinされたcandidateからも同じ下書きを再構築できる。
//
// 絶対条件: message本文・snippetのいずれも引数に取らない(下書き自体が
// body-independentであるため、REF-P1のfrozen designと矛盾しない)。
export interface GmailReferentReplyTarget {
  sourceMessageRef: string;
  sender: string;
  normalizedSubject: string;
}

export function proposeGmailReplyFromReferent(
  intent: ResolvedWorkIntent,
  target: GmailReferentReplyTarget,
  sourceReferent?: SourceReferentSnapshot
): GmailReplyProposal | undefined {
  if (intent.requestType !== "act" && intent.requestType !== "prepare") return undefined;

  const to = parseSingleAddress(target.sender);
  const subject = replySubject(target.normalizedSubject);
  if (!to || !subject) return undefined;

  return {
    action: { service: "gmail", operation: "send_message", input: { to: [to], subject, bodyText: buildReplyBodyText(intent) } },
    reason: "関連する受信メールへの返信案を作成しました。",
    sourceMessageRef: target.sourceMessageRef,
    ...(sourceReferent ? { sourceReferent } : {}),
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
