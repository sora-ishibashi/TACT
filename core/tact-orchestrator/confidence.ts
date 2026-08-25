import type { ResearchResult } from "../tact-research/types";

// =========================
// deriveAnswerConfidence (Phase 21)
// =========================
//
// 目的: Phase14のGap D(Confidence Signal)。「TACTが最終回答をどの程度
// 確信してよいか」(Step2のB. Answer confidence)を、既存のResearchResult
// だけから決定論的に算出する純粋関数。新しいLLM呼び出しは一切行わない
// (絶対条件2)。
//
// Reality Test(Phase21 Step3)で確認した実害: 「最新のiPhoneモデルに
// ついて調べて」という強いEvidenceが期待できる質問でも、実際には
// evidence 2件のうち1件がconfidence:"low"(picky-s.jp)だったにも
// 関わらず、最終回答は一切のhedgeなく断定的に提示されていた
// (false certainty)。逆に「中京大学工学部の2025年度入学者数について
// 調べて」ではevidence 0件で、回答文自体は「確認できませんでした」と
// 適切に述べていたが、result.successは両ケースとも true であり、
// success真偽値だけでは「回答の確からしさ」を一切区別できないことを
// 実測で確認した。
//
// 絶対条件5(Evidence confidenceとの混同禁止): この関数は
// Evidence.confidence(個々のEvidence自体の信頼度、core/context/
// types.ts)を「集約」するが、それを上書き・再定義するものではない。
// AnswerConfidenceは「この回答が、集めたEvidence全体によってどの程度
// 裏付けられているか」という、Evidenceより1段階上の軸である。
//
// Step6の方針(precision illusionの回避): 0.87のような校正根拠のない
// 数値は作らない。意味が明確な離散値のみを返す。
//   - "supported"           … Evidenceがあり、low confidenceのものが無い
//   - "partially_supported" … Evidenceはあるが、一部がlow confidence
//   - "insufficient_evidence" … Evidenceが1件も無い
// success=falseの場合(Task自体が失敗)はundefined(「実行が失敗した」
// ことと「回答の確信度が低い」ことを混同しない、絶対条件5と同じ精神。
// Step2のC. Execution confidenceとは独立した軸として扱う)。
export type AnswerConfidence =
  | "supported"
  | "partially_supported"
  | "insufficient_evidence";

export function deriveAnswerConfidence(
  result: ResearchResult
): AnswerConfidence | undefined {

  if (!result.success) {

    // Task実行自体が失敗した場合、「回答」自体が存在しないため
    // Answer Confidenceの対象外(Execution confidenceの領域であり、
    // TaskExecutionSummary.status/errorが既に表現している)。
    return undefined;

  }

  if (result.evidence.length === 0) {

    // core-only経路でも「十分に関連度の高いCore情報が一意に存在する」
    // ことをanswerability.tsが既に確認済みのため、実際にはevidence 0件で
    // success:trueになるのはweb-research経路(Web Evidenceが1件も
    // 見つからなかった場合)のみ(Phase21 Reality Test Case Bで実測)。
    return "insufficient_evidence";

  }

  const hasLowConfidenceEvidence = result.evidence.some(
    (item) => item.confidence === "low"
  );

  return hasLowConfidenceEvidence ? "partially_supported" : "supported";

}
