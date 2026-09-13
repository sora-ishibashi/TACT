// =========================
// TACT Work — Gmail Referent Candidate Generation / Safe Sender
// Narrowing (REF-P1 LIVE FIX 1)
// =========================
//
// 対象: core/tact-work/gmailReferentCandidates.tsのextractSafeSenderEmail()。
// LIVE Root Cause(REF-P1 LIVE Diagnostic 1)の再発防止regression。
// 完全にpure(DBアクセス・Provider呼び出し・LLMのいずれも無い)。

import { extractSafeSenderEmail } from "../../../core/tact-work/gmailReferentCandidates";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. 会社名ラベル ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 1. 会社名ラベル「TACTテスト商事」はsender narrow queryとして安全ではない(undefined)",
    extractSafeSenderEmail("TACTテスト商事") === undefined
  ));

  // ---- 2. 氏名ラベル ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 2. 氏名ラベル「田中さん」はsender narrow queryとして安全ではない(undefined)",
    extractSafeSenderEmail("田中さん") === undefined
  ));

  // 補助: 他のありがちな人間ラベルも同様に拒否する。
  results.push(check(
    "[REF-P1 LIVE FIX 1] 2b. 「A社」「営業部」「先方」も同様に拒否する",
    extractSafeSenderEmail("A社") === undefined &&
      extractSafeSenderEmail("営業部") === undefined &&
      extractSafeSenderEmail("先方") === undefined
  ));

  // ---- 3. 生のemail address ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 3. 生のemail address「tanaka@example.com」はそのまま安全(eligible)",
    extractSafeSenderEmail("tanaka@example.com") === "tanaka@example.com"
  ));

  // ---- 4. 表示名付きemail ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 4. 「田中 <tanaka@example.com>」はtanaka@example.comとして安全(eligible)",
    extractSafeSenderEmail("田中 <tanaka@example.com>") === "tanaka@example.com"
  ));

  // ---- 5. 複数email混入 ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 5a. カンマ区切りの複数emailは安全ではない(undefined)",
    extractSafeSenderEmail("tanaka@example.com, sato@example.com") === undefined
  ));

  results.push(check(
    "[REF-P1 LIVE FIX 1] 5b. 空白区切りの複数emailも安全ではない(undefined)",
    extractSafeSenderEmail("tanaka@example.com sato@example.com") === undefined
  ));

  results.push(check(
    "[REF-P1 LIVE FIX 1] 5c. angle-bracket内外にemailが分散する形も安全ではない(undefined、fuzzy parsingで片方だけ採用しない)",
    extractSafeSenderEmail("tanaka@example.com 田中 <sato@example.com>") === undefined
  ));

  // ---- 補助: 空文字・大文字小文字混在 ----
  results.push(check(
    "[REF-P1 LIVE FIX 1] 補助a. 空文字は安全ではない(undefined)",
    extractSafeSenderEmail("") === undefined && extractSafeSenderEmail("   ") === undefined
  ));

  results.push(check(
    "[REF-P1 LIVE FIX 1] 補助b. 大文字混じりのemailはlowercaseへ正規化される",
    extractSafeSenderEmail("Tanaka@Example.com") === "tanaka@example.com"
  ));

  results.push(check(
    "[REF-P1 LIVE FIX 1] 補助c. \"@\"を含まないランダムな文字列は安全ではない",
    extractSafeSenderEmail("これはメールアドレスではありません") === undefined
  ));

  return summarize("work/gmailReferentCandidates", results);

}
