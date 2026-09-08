// =========================
// TACT Bot — Slack Text Approval Decision Detector (S1e)
// =========================
//
// Slack inbound app_mentionのnormalized text(既存
// normalizeSlackAppMentionEvent()がmention除去・trim済みのtext)から、
// 「これはApproval decision(承認/却下)の意思表示か」を決定論的に
// 判定する純粋関数。LLMは一切使わない(絶対条件2、11)。
//
// 絶対条件(Accuracy > Coverage、既存core/tact-intent/ruleRouter.tsと
// 同じ設計哲学): 「承認について教えて」「これは承認が必要?」のような
// 言及・質問と、実際の意思表示を取り違えないよう、trim後の
// **全文完全一致**だけを対象にする(substring matchingは禁止)。
// 曖昧な文からApprovalを推測しない。
//
// このfileはDBアクセス・identity解決・Approval解決のいずれも行わない
// (pure function、Slack-specific text parsingだけに責務を限定する)。
// Approval ID解決はcore/tact-bot/execution/
// resolvePendingApprovalForThread.tsの責務(絶対条件8: Slack-specific
// parsingをcore/tact-workへ入れない、かつcore/tact-work側もSlackの
// 語彙を知らない)。

export type ApprovalDecisionTextMatch =
  | { matched: false }
  | { matched: true; decision: "approve" | "reject" };

// 全文完全一致のみを対象にする候補文字列(小文字化して比較、日本語は
// toLowerCase()の影響を受けないため英語/日本語を同じ比較ロジックで
// 扱える)。将来語彙を増やす場合もこのSetへ追加するだけで済むよう、
// 決定論的な完全一致リストという設計を維持する(正規表現の複雑化を
// 避ける)。
const APPROVE_PHRASES = new Set(["承認", "承認します", "approve"]);
const REJECT_PHRASES = new Set(["却下", "却下します", "reject"]);

export function detectApprovalDecisionText(text: string): ApprovalDecisionTextMatch {

  const normalized = text.trim().toLowerCase();

  if (!normalized) {
    return { matched: false };
  }

  if (APPROVE_PHRASES.has(normalized)) {
    return { matched: true, decision: "approve" };
  }

  if (REJECT_PHRASES.has(normalized)) {
    return { matched: true, decision: "reject" };
  }

  return { matched: false };

}
