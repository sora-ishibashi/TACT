import { Evidence } from "../context/types";
import { retrieveEvidence } from "./retrieveEvidence";
import { rankEvidence } from "./rankEvidence";

export function selectEvidence(
  evidence: Evidence[],
  query: string,
  limit = 15
): Evidence[] {

  // 1. キーワード関連度・confidence・sourceType・freshnessを
  //    合成したスコアで上位limit件を選ぶ（retrieveEvidenceの責務）
  const selected =
    retrieveEvidence(
      evidence,
      query,
      limit
    );

  // 2. 選ばれたlimit件の中の最終的な提示順は、
  //    sourceType/confidence/freshnessを評価するrankEvidenceに委ねる
  //    （旧: item.scoreのみでの再ソート）
  return rankEvidence(selected);

}