// =========================
// TACT Work — Gmail Candidate Generation for Referent Resolution (REF-P1f)
// =========================
//
// core/tact-referent/*(REF-P1a〜P1d)は完全に自己完結したpure domain
// moduleであり、core/tact-integration(Gmail検索の実行境界)を一切
// importしない(frozen Dependency Rule)。このfileはその境界を跨ぐ
// 唯一の変換層——core/tact-integrationのGmailSearchMessagesResult
// (provider-neutral、既に正規化済み)を、core/tact-referentの
// CommunicationCandidateへ決定論的にmapするだけの、純粋関数のみの
// module。DBアクセス・Provider呼び出しはここでは一切行わない
// (呼び出し元、core/tact-conversation/orchestration.tsの責務)。
//
// 絶対条件(このphaseの明示的指示を継承):
//   - body/snippet相当のfieldをCommunicationCandidateへ持ち込まない。
//   - directionは常に"unknown"(outboundを自動的に断定しない、
//     core/tact-referent/types.tsのDesign Freeze §17/§18)。

import type { GmailMessageSummary, GmailSearchMessagesResult } from "../tact-integration";
import type { CommunicationCandidate } from "../tact-referent/types";

// このphaseの明示的な安全上限(Clarificationで直接選択させてよい
// candidate件数の上限)。これを超える場合は番号付き選択肢を一切
// 提示せず、より絞り込んだ条件を尋ねる(REF-P2のLarge Candidate Set
// Reduction/Attribute Clarificationはこのphaseのscope外)。
export const MAX_DIRECT_REFERENT_CHOICES = 5;

// core/tact-work/gmailReplyProposal.tsのparseSingleAddress()と同じ
// 抽出規則(angle-bracket形式優先、単一addressのみ)。同一ロジックを
// 2箇所に持つと乖離するリスクがあるが、tact-referent側のfrozen
// dependency ruleにより共有moduleを新設する余地が無いため、この
// 1箇所のみで意図的に複製する(コメントで明記、gmailReplyProposal.ts
// 側も同じ理由を記載する)。
function parseSingleSenderAddress(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const matched = from.match(/<([^<>\s,;]+@[^<>\s,;]+)>/u)?.[1] ?? from.trim();
  return /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/u.test(matched)
    ? matched.toLowerCase()
    : undefined;
}

// CommunicationCandidate.normalizedSubjectの契約("正規化済みsubjectの
// みRe:/Fwd:等のprefix除去・空白正規化後")をここで唯一実装する。
export function normalizeGmailSubject(subject: string | undefined): string | undefined {
  const normalized = subject?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const stripped = normalized.replace(/^(?:re|fw|fwd)\s*:\s*/iu, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

function toCommunicationCandidate(message: GmailMessageSummary): CommunicationCandidate {

  const sender = parseSingleSenderAddress(message.from);
  const normalizedSubject = normalizeGmailSubject(message.subject);

  return {
    kind: "gmail_message",
    messageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(sender ? { sender } : {}),
    ...(normalizedSubject ? { normalizedSubject } : {}),
    ...(message.date ? { observedAt: message.date } : {}),
    // 絶対条件(Design Freeze §17/§18): connected accountのaddressを
    // 取得する手段がこのrepoに無いため、outboundを一切断定しない。
    direction: "unknown",
  };

}

/**
 * Gmail検索結果(provider-neutral、既にcore/tact-integrationで正規化
 * 済み)を、Referent Resolverが読めるCommunicationCandidate配列へ
 * 変換する。body/snippetはこの関数の入力・出力のいずれにも一切
 * 現れない(GmailMessageSummary自体は保持し得るが、この関数は
 * それらのfieldを読まない)。
 */
export function communicationCandidatesFromGmailSearch(
  result: GmailSearchMessagesResult | undefined
): readonly CommunicationCandidate[] {

  if (!result) {
    return [];
  }

  return result.messages.map(toCommunicationCandidate);

}

// =========================
// extractSafeSenderEmail (REF-P1 LIVE FIX 1)
// =========================
//
// LIVE Root Cause: core/tact-referent/signals.tsのReferentSignal(kind:
// "sender")は、明示的な「から」を伴う会社名・氏名ラベル(例:
// "TACTテスト商事"・"田中さん")も正当なsender signalとして生成する
// (P1b frozen、discourse/signals層の責務——人間が読む会話としては
// 正しい)。しかしGmailのfrom:検索はemail address前提のprovider
// semanticsであり、会社名・氏名ラベルをそのままfrom:へ渡しても
// technicalには成功する(providerがエラーを返さない)が、意味的には
// 何にも一致しない0件検索になる——production incidentの実際の原因
// (REF-P1 LIVE Diagnostic 1で確認済み)。
//
// 絶対条件(このphaseの明示的指示):
//   - contact resolution(会社名/氏名→email推測)は一切行わない。
//   - fuzzy parsingをしない——決定論的・provider API呼び出し無し。
//   - 値全体に含まれるemail address相当のtoken数を数え、正確に1件
//     以外(0件または2件以上)は安全ではないとしてfail closedする
//     (「表示名 <email> の外側にも別のemailが紛れている」ような
//     曖昧な入力も、angle-bracket内だけを見て見逃さない)。
//
// 許容する形: bare email(例: "tanaka@example.com")、または
// 「表示名 <email>」形式(例: "田中 <tanaka@example.com>")。
// 拒否する形: 会社名・氏名ラベル(email token自体が無い)、
// カンマ/空白区切りの複数email、angle-bracket内外にemailが分散する形。
export function extractSafeSenderEmail(value: string): string | undefined {

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  // "@"の総出現数で複数email混入を検出する(bare/angle-bracketいずれの
  // 形でも、値全体に"@"が2個以上あれば安全ではないと判断する)。
  const atCount = (trimmed.match(/@/gu) ?? []).length;

  if (atCount !== 1) {
    return undefined;
  }

  const angleBracketMatch = trimmed.match(/<([^<>\s,;]+@[^<>\s,;]+)>/u);
  const candidate = (angleBracketMatch ? angleBracketMatch[1] : trimmed).trim();

  const normalized = candidate.toLowerCase();

  return /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/u.test(normalized)
    ? normalized
    : undefined;

}
