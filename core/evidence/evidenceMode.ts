// =========================
// evidenceMode (STEP70)
// =========================
//
// 背景: STEP69の調査で、getTeam()の全カテゴリが例外なくresearcher
// (＋queryBuilder)を含むため、Evidenceを必要としないタスク
// (リライト・要約・キャプション生成・壁打ち等)にも常にResearcherが
// 実行され、不要なLLM呼び出し・待ち時間が発生していることが判明した。
//
// 本モジュールは、「今回の依頼がどの程度Evidenceを必要とするか」を
// userInputから機械的に判定するだけの純関数を提供する。
//
// 重要な設計方針(STEP70の指示に基づく):
// ・ユーザー入力を毎回LLMに投げて判定する実装は禁止されている。
//   そのため、既存のSTEP33 detectResearchRequirement()(正規表現ベース、
//   既存の呼び出し元・挙動は一切変更しない)と、既存のSTEP39
//   IDEA_MODE_MARKER(Conversation層のTask ReconstructionというLLM呼び出しが
//   既に算出済みのconversationModeを、composedTaskへ埋め込む形で
//   Workflow層へ伝播させる既存の仕組み)を再利用し、新しい分類ロジックの
//   大部分は「既存シグナルの組み合わせ」で構成する。
// ・「Evidence不要」と積極的に判定できた場合のみ"none"を返し、
//   それ以外(判定が難しいケースを含む)は既存の挙動(Researcherを実行する)を
//   維持する"helpful"を返す。安全側に倒す設計であり、
//   「壁打ちにResearcherを呼んでしまう」ことより
//   「本来調査が必要な依頼でResearcherを飛ばしてしまう」ことの方が
//   有害だという判断に基づく。

import { detectResearchRequirement } from "./researchRequirement";
import { IDEA_MODE_MARKER } from "../workflow/ideaMode";

export type EvidenceMode =
  | "none"
  | "helpful"
  | "required"
  | "primary-source-required";

// 一次情報・公式情報を明示的に要求するシグナル。
// STEP33のEXPLICIT_SEARCH_PATTERNSに既に含まれる語彙(一次情報/公式情報/
// 公式サイト)と重なるが、あちらは「検索が必要か」の判定用であり、
// こちらは「その中でも一次情報を優先すべきか」というより強い階層を
// 区別するためのものなので、意図的に独立した配列として持つ。
const PRIMARY_SOURCE_PATTERNS: RegExp[] = [

  /一次情報/,
  /一次資料/,
  /公式情報/,
  /公式サイト/,
  /公式発表/,
  /原典/,

];

// Evidenceを必要としない典型的なタスクのシグナル。
// STEP70の指示にある具体例(リライト・文字数調整・タイトル案・壁打ち・
// キャプション生成・カジュアル化)をカバーする。既存のuser-provided textを
// 対象とした変換・整形・相談であり、新しい事実の調査を伴わない依頼のみを
// 対象にする(過剰マッチによる誤爆を避けるため、語彙は絞ってある)。

// 文体・トーンの変更(既存文章の書き換え)
const REWRITE_STYLE_PATTERNS: RegExp[] = [

  /自然な日本語/,
  /カジュアルに/,
  /フォーマルに/,
  /丁寧な(文章|言葉|表現)/,
  /口調/,
  /トーン/,
  /言い換え/,
  /リライト/,
  /書き換えて/,
  /文体/,

];

// 分量・形式の調整(既存文章の整形。新しい情報の追加は伴わない)
//
// STEP76: MECHANICAL_EDIT_PATTERNS(→QualityProfile=instant判定)の
// カバレッジ調査で、「300字にして」(「文字」ではなく「字」)・
// 「文字数を調整して」(具体的な数値を伴わない)・「Markdownを整形して」
// のような、機械的変換の範疇にありながら既存パターンに一致しない
// 実例が判明したため、パターンを追加した(新しいカテゴリの新設ではなく、
// 同じREFORMAT_PATTERNSの範囲内での穴埋め)。
const REFORMAT_PATTERNS: RegExp[] = [

  /\d+\s*(文字|字)(に|へ)(して|し直し)/,
  /(短く|簡潔に)(して|し直し)/,
  /要約して/,
  /まとめ直して/,
  /文字数(を)?調整/,
  /整形して/,

];

// 既存内容からのタイトル・見出し・キャプション・コピー案出し
const IDEATION_ON_EXISTING_TEXT_PATTERNS: RegExp[] = [

  /タイトルを.{0,10}(考え|出し)/,
  // STEP76: 「タイトルだけ直して」のような、対象を明示的に
  // タイトルだけへ限定する言い回しを追加。「だけ」を含めることで、
  // 「タイトルを大幅に修正して、内容も見直して」のような、より
  // 広い範囲の変更を意図した依頼までは拾わないようにする
  // (安全側。マッチ範囲を広げすぎない)。
  /タイトルだけ.{0,10}(直し|修正)/,
  /見出しを.{0,10}(考え|出し)/,
  /キャプション/,
  /コピーを.{0,10}(考え|作)/,

];

// 校正・誤字修正
const PROOFREAD_PATTERNS: RegExp[] = [

  /誤字/,
  /脱字/,
  /校正/,
  /添削/,
  // STEP76: 表記ゆれの統一も、新しい事実の追加を伴わない機械的な
  // 校正作業の一種として扱う。
  /表記(を)?統一/,

];

// 壁打ち・相談・ブレインストーミング
const CONSULTATION_PATTERNS: RegExp[] = [

  /壁打ち/,
  /ブレスト/,
  /ブレイン(ストーミング)?/,
  /相談(に乗|して|したい)/,
  /悩んで/,
  /アイデア.{0,10}(出し|考え)/,

];

const NO_EVIDENCE_NEEDED_PATTERNS: RegExp[] = [

  ...REWRITE_STYLE_PATTERNS,
  ...REFORMAT_PATTERNS,
  ...IDEATION_ON_EXISTING_TEXT_PATTERNS,
  ...PROOFREAD_PATTERNS,
  ...CONSULTATION_PATTERNS,

];

// STEP71: core/workflow/qualityProfile.tsが再利用するための輸出。
// NO_EVIDENCE_NEEDED_PATTERNSのうち、「機械的な変換・整形」に相当する
// 部分集合(分量調整・校正・既存文からのタイトル/キャプション案出し)。
// REWRITE_STYLE_PATTERNS・CONSULTATION_PATTERNS(トーン変更・壁打ち等、
// ある程度の判断を伴う依頼)は含めない。detectEvidenceMode()自体の
// 判定ロジック・戻り値は変更しない(このexportは既存の配列を
// 外部から参照可能にするだけの追加)。
export const MECHANICAL_EDIT_PATTERNS: RegExp[] = [

  ...REFORMAT_PATTERNS,
  ...IDEATION_ON_EXISTING_TEXT_PATTERNS,
  ...PROOFREAD_PATTERNS,

];

// =========================
// detectEvidenceMode
// =========================
//
// 優先順位(強いシグナルを先に判定する):
//   1. 一次情報・公式情報の明示要求 → "primary-source-required"
//   2. STEP33 detectResearchRequirement()(既存、変更なし)が真 → "required"
//   3. Idea Mode(既存STEP39マーカー)、またはEvidence不要の典型パターン
//      → "none"
//   4. それ以外(判定できない・曖昧なケースを含む) → "helpful"
//      (安全側のデフォルト。既存のResearcher実行を維持する)
//
// 1・2が同時にマッチする場合は1を優先する(より強い要求を採用する)。
// 1・2のいずれかがマッチした場合、3の判定は行わない
// (「最新情報を使って壁打ちして」のような複合的な依頼で、
// 誤ってEvidenceを不要と判定しないための安全策)。
export function detectEvidenceMode(
  userInput: string
): EvidenceMode {

  if (!userInput) return "helpful";

  if (PRIMARY_SOURCE_PATTERNS.some((p) => p.test(userInput))) {
    return "primary-source-required";
  }

  if (detectResearchRequirement(userInput)) {
    return "required";
  }

  const hasIdeaMarker =
    userInput.includes(IDEA_MODE_MARKER);

  const hasNoEvidenceSignal =
    NO_EVIDENCE_NEEDED_PATTERNS.some((p) => p.test(userInput));

  if (hasIdeaMarker || hasNoEvidenceSignal) {
    return "none";
  }

  return "helpful";

}
