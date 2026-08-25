import { normalizeResult } from "./normalize";
import { Evidence } from "@/core/context/types";
import { removeDuplicates } from "./removeDuplicates";
import { autoTag } from "./autoTag";
import { scoreEvidence } from "@/core/evidence/scoreEvidence";
import { inferSourceType } from "@/core/evidence/retrieveEvidence";

export function executeEvidencePipeline(
  results: any[],
  createdBy = "researcher"
): Evidence[] {

  const evidence =
    buildEvidence(
      results,
      createdBy
    ).map(autoTag);

  return removeDuplicates(

    evidence,

    item =>
      `${item.claim}${item.source}`

  );

}

export function buildEvidence(
  results: any[],
  createdBy = "researcher"
): Evidence[] {

  return results.map((item) => {

    const normalized =
      normalizeResult(item);

    const evidence: Evidence = {

      id: crypto.randomUUID(),

      claim:
        normalized.claim,

      evidence:
        normalized.evidence,

      source:
        normalized.source,

      confidence:
        convertConfidence(
          normalized.score
        ),

      score: 0,

      // Phase43: normalizeResult()が素通しした実データをそのまま使う。
      // Providerが日時を返さなかった場合はundefinedのまま(推測しない、
      // 絶対条件Rule2)。
      publishedAt: normalized.publishedAt,

      // Phase43: publishedAt(情報源が公開した時刻)とは別概念、TACTが
      // この検索結果を実際に取得した時刻(絶対条件Rule3)。Evidence型に
      // 既に存在していたが、これまで設定箇所が無く常にundefinedだった
      // フィールド。createdAt(number、Date.now())と役割が重複する
      // ように見えるが、createdAtはEvidenceオブジェクト自体の生成時刻
      // (既存フィールド、型もnumberで別物)であり、混同しない
      // (絶対条件Rule4/5: createdAt/updatedAtをpublishedAtの代用にしない、
      // という制約とは別に、ここでは新たにretrievedAtへ「今」を設定する
      // だけであり、他フィールドからの代用ではない)。
      retrievedAt: new Date().toISOString(),

      sourceType:
        inferSourceType(
          normalized.source
        ),

      createdBy,

      createdAt: Date.now(),

      tags: [],

    };

    evidence.score =
      scoreEvidence(evidence);

    return evidence;

  });

}

function convertConfidence(
  score: number | undefined
): "low" | "medium" | "high" {

  if (!score) return "medium";

  if (score >= 0.9) return "high";

  if (score >= 0.7) return "medium";

  return "low";

}