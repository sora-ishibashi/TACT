// =========================
// destination (STEP74)
// =========================
//
// 背景: STEP73の調査で、「TACT本体で完結させるか、TACT Designへ渡すか」
// という軸(Destination)が、現状のコードに一切存在しないことが判明した。
// 本モジュールは、userInputから「TACT Designへ渡すことが明示的に
// 求められているか」を機械的に判定するだけの純関数を提供する。
//
// 重要な設計方針(STEP74の指示に基づく):
// ・新しいLLM呼び出しは追加しない(detectEvidenceMode()/
//   detectQualityProfile()と同じ決定論的パターンマッチング)。
// ・「明示的にDesignを指定していない場合」は安全側として必ず"tact"を返す。
//   誤ってTACT Design向けの処理へ送る方が、単純にTACT本体で完結させる
//   より影響範囲が大きいため(STEP74指示)。artifactType(presentation等)
//   だけからdestinationを推測することはしない
//   (docs/output-type-workflow-architecture.md 7章で「DocumentFormatは
//   Destinationを決め打ちしない」と結論済み。プレゼン資料の構成だけを
//   TACT本体で読みたいケースも有り得るため)。

import { Destination } from "../context/types";

const DESIGN_DESTINATION_PATTERNS: RegExp[] = [

  // 「デザインに渡して」「デザインへ送って」等、明示的な受け渡し要求
  /デザイン(に|へ)(渡し|渡して|送っ|送って)/,

  // 製品名としての「TACT Design」への明示的な言及
  /TACT\s*Design/i,

  // 「デザインで編集したい」等
  /デザインで編集/,

];

export function detectDestination(
  userInput: string
): Destination {

  if (!userInput) return "tact";

  if (
    DESIGN_DESTINATION_PATTERNS.some((p) => p.test(userInput))
  ) {
    return "design";
  }

  return "tact";

}
