// =========================
// TACT Bot — Slack Text Approval Decision Detector Regression (S1e)
// =========================
//
// 対象: core/tact-bot/adapters/slack/detectApprovalDecisionText.ts。
// 純粋関数のみ、DB/identity解決/LLMのいずれにも依存しない。

import { detectApprovalDecisionText } from "../../../core/tact-bot/adapters/slack/detectApprovalDecisionText";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case1: 「承認」 -> approve ----
  {
    const result = detectApprovalDecisionText("承認");
    results.push(check("[Case1] 「承認」はapproveとしてmatchする", result.matched === true && result.decision === "approve"));
  }

  // ---- Case2: 「承認します」 -> approve ----
  {
    const result = detectApprovalDecisionText("承認します");
    results.push(check("[Case2] 「承認します」はapproveとしてmatchする", result.matched === true && result.decision === "approve"));
  }

  // ---- Case3: 「却下」 -> reject ----
  {
    const result = detectApprovalDecisionText("却下");
    results.push(check("[Case3] 「却下」はrejectとしてmatchする", result.matched === true && result.decision === "reject"));
  }

  // ---- Case4: 「却下します」 -> reject ----
  {
    const result = detectApprovalDecisionText("却下します");
    results.push(check("[Case4] 「却下します」はrejectとしてmatchする", result.matched === true && result.decision === "reject"));
  }

  // ---- Case5: 前後の空白がtrimされる ----
  {
    const result = detectApprovalDecisionText("  承認  ");
    results.push(check("[Case5] 前後に空白があってもtrimされ、approveとしてmatchする", result.matched === true && result.decision === "approve"));
  }

  // ---- Case6: 「承認について教えて」 -> no match(言及であって意思表示ではない) ----
  {
    const result = detectApprovalDecisionText("承認について教えて");
    results.push(check("[Case6] 「承認について教えて」はmatchしない(substring matching禁止、全文完全一致のみ)", result.matched === false));
  }

  // ---- Case7: 「これは承認」 -> no match ----
  {
    const result = detectApprovalDecisionText("これは承認");
    results.push(check("[Case7] 「これは承認」はmatchしない(全文完全一致のみ)", result.matched === false));
  }

  // ---- Case8: 通常の会話 -> no match ----
  {
    const result = detectApprovalDecisionText("こんにちは");
    results.push(check("[Case8] 通常の挨拶はmatchしない", result.matched === false));
  }

  // ---- Case9: 空文字 -> no match ----
  {
    const empty = detectApprovalDecisionText("");
    const whitespaceOnly = detectApprovalDecisionText("   ");
    results.push(
      check(
        "[Case9] 空文字・空白のみの入力はmatchしない",
        empty.matched === false && whitespaceOnly.matched === false
      )
    );
  }

  // ---- Case10: 英語表記・大文字小文字の揺れに対応する ----
  {
    const lower = detectApprovalDecisionText("approve");
    const upper = detectApprovalDecisionText("APPROVE");
    const mixed = detectApprovalDecisionText("Reject");

    results.push(
      check(
        "[Case10] 英語表記(大文字小文字を問わず)approve/rejectも正しくmatchする",
        lower.matched === true && lower.decision === "approve" &&
          upper.matched === true && upper.decision === "approve" &&
          mixed.matched === true && mixed.decision === "reject"
      )
    );
  }

  // ---- 追加: 「承認されましたか?」「これは承認が必要?」のような疑問文もmatchしない ----
  {
    const q1 = detectApprovalDecisionText("承認されましたか?");
    const q2 = detectApprovalDecisionText("これは承認が必要?");

    results.push(
      check(
        "[追加] 「承認されましたか?」「これは承認が必要?」等の疑問文はmatchしない",
        q1.matched === false && q2.matched === false
      )
    );
  }

  return summarize("bot/detectApprovalDecisionText", results);

}
