// =========================
// requirementSafety (STEP187)
// =========================
//
// STEP185〜186で発見された「共有prefix汚染」(同じ主語を持つ
// Requirement同士が、n-gramの部分一致だけでcoveredと誤判定される
// 問題)を、関連度アルゴリズム自体を変更せずに補正するための、
// 決定論的な安全チェック。
//
// 重要(STEP187絶対条件): scoreRelevance()・Embedding・Vector Search・
// LLMは一切使用しない。ここでの判定は、Requirementの文字列と
// Core側の一致候補(matched item)の文字列を、正規表現・固定語彙
// リストだけで比較する、純粋なCODE処理。
//
// 最重要方針: この安全チェックは「安全側にしか動かさない」
// (covered→partial/missingのみ許可、逆方向の昇格は行わない)。
// knowledgeGap.tsのclassifyRequirement()から、status==="covered"の
// 場合にのみ呼び出される想定。

// 既存のhasTimeSensitiveSignal()(answerability.ts)をそのまま再利用
// する(新しい時間依存判定を作らない、というSTEP187絶対条件)。
import { hasTimeSensitiveSignal } from "./answerability";

export type RequirementSafetyIssue =
  | "time_mismatch"
  | "numeric_mismatch"
  | "attribute_mismatch";

export interface RequirementSafetyResult {

  safe: boolean;

  issues: RequirementSafetyIssue[];

}

// =========================
// 1. 年・年度の不一致検出(Rule 1, Rule 2)
// =========================
//
// 「2024年」「2024年度」「FY2024」「FY24」のような表記を対象とする。
const YEAR_PATTERN = /FY\s?(\d{2,4})|(\d{4})年度?/g;

function normalizeYear(rawYear: string): string {

  // "FY24"のような2桁表記は、2000年代前提で4桁化する
  // (TACTの利用文脈上、1900年代の年度を扱う想定がないため)。
  if (rawYear.length === 2) {
    return `20${rawYear}`;
  }

  return rawYear;

}

function extractYears(text: string): Set<string> {

  const years = new Set<string>();

  for (const match of text.matchAll(YEAR_PATTERN)) {

    const rawYear = match[1] ?? match[2];

    if (rawYear) {
      years.add(normalizeYear(rawYear));
    }

  }

  return years;

}

// Rule 1: Requirement・matchedTextの両方に年の言及があるが、
// 一致する年が1つも無い場合は不一致とみなす。
// Rule 2: Requirementには年の言及があるが、matchedTextには
// 一切年の言及が無い場合も、対応する時点の情報かどうか確認できない
// ため不一致とみなす(安全側)。
function detectYearMismatch(
  requirementQuery: string,
  matchedText: string
): boolean {

  const requirementYears = extractYears(requirementQuery);

  if (requirementYears.size === 0) {
    // Requirement自体が特定の年を要求していない場合は対象外。
    return false;
  }

  const matchedYears = extractYears(matchedText);

  if (matchedYears.size === 0) {
    // Rule 2: Requirementは年を指定しているのに、Core側の一致候補は
    // どの年の情報か分からない。
    return true;
  }

  const hasOverlap = [...requirementYears].some((year) =>
    matchedYears.has(year)
  );

  // Rule 1: 年の言及自体はあるが、指定された年が一致しない。
  return !hasOverlap;

}

// =========================
// 2. 最新性要求 + Core情報の時点が古い(Rule 3)
// =========================

function detectFreshnessMismatch(
  requirementQuery: string,
  matchedText: string
): boolean {

  if (!hasTimeSensitiveSignal(requirementQuery)) {
    return false;
  }

  // 重要: hasTimeSensitiveSignal()(answerability.ts)は「最新」
  // 「現在」等の言葉だけでなく、/20\d{2}年/(明示的な年号の言及)にも
  // 反応する(元々はCore-only全体を時間依存として扱うための広い
  // シグナル)。Requirementが既に明示的な年を指定している場合、
  // その年が一致するかどうかはRule 1(detectYearMismatch)が厳密に
  // 判定するため、ここで重複して「古い」と判定すると、
  // 「2024年度」の質問に「2024年度」のCoreが一致しているのに
  // 不一致とみなしてしまう(STEP187監査で発見・修正)。
  // Requirementに明示的な年が無い、真に曖昧な最新性要求
  // (「最新の」「現在の」等)の場合のみ、この関数で判定する。
  if (extractYears(requirementQuery).size > 0) {
    return false;
  }

  const matchedYears = extractYears(matchedText);

  if (matchedYears.size === 0) {
    // Core側にそもそも年の言及が無い場合、「古い」と断定する材料が
    // 無いため、この検出では不一致としない(過剰反応を避ける安全策。
    // ただしdetectYearMismatch()はRequirement側に年が無ければ
    // 対象外になるため、ここでは重複しない)。
    return false;
  }

  const currentYear = new Date().getFullYear();

  // matchedTextに言及されている年が、すべて「現在年より前」である
  // 場合のみ、古い情報とみなす。
  return [...matchedYears].every(
    (year) => currentYear - parseInt(year, 10) >= 1
  );

}

// =========================
// 3. 明示的な数値の不一致検出
// =========================
//
// 単位を伴う明示的な数値(「500円」「100億円」「30%」等)のみを
// 対象とする。UUID・電話番号・URL内の数字・箇条書き番号のような、
// 単位を伴わない生の数字列は対象外とする(過剰反応を避けるため)。
const UNIT_NUMBER_PATTERN =
  /(\d+(?:\.\d+)?)\s*(円|億円|万円|兆円|億|万|人|件|%|パーセント|店舗?)/g;

function extractUnitNumbers(text: string): Set<string> {

  const numbers = new Set<string>();

  for (const match of text.matchAll(UNIT_NUMBER_PATTERN)) {
    numbers.add(`${match[1]}${match[2]}`);
  }

  return numbers;

}

function detectNumericMismatch(
  requirementQuery: string,
  matchedText: string
): boolean {

  const requirementNumbers = extractUnitNumbers(requirementQuery);

  if (requirementNumbers.size === 0) {
    return false;
  }

  const matchedNumbers = extractUnitNumbers(matchedText);

  if (matchedNumbers.size === 0) {
    // Core側に単位付き数値の言及が無ければ、比較材料が無いため
    // 不一致とはしない(Requirement側の数値がCore側に無いことと、
    // 「異なる数値がある」ことは別の問題)。
    return false;
  }

  const hasOverlap = [...requirementNumbers].some((number) =>
    matchedNumbers.has(number)
  );

  return !hasOverlap;

}

// =========================
// 4. 属性の対概念による不一致検出(Rule 4)
// =========================
//
// 明確に対になる語のペアが、Requirement/Core双方で「片方だけ」
// 明示されており、かつ異なる側を指している場合のみ不一致とみなす
// (両方に両方の語が含まれる場合等、曖昧なケースは判定しない)。
const ATTRIBUTE_PAIRS: readonly [string, string][] = [
  ["国内", "海外"],
  ["男性", "女性"],
  ["新卒", "中途"],
  ["個人", "法人"],
  ["BtoB", "BtoC"],
];

function detectAttributeMismatch(
  requirementQuery: string,
  matchedText: string
): boolean {

  for (const [sideA, sideB] of ATTRIBUTE_PAIRS) {

    const requirementHasA = requirementQuery.includes(sideA);
    const requirementHasB = requirementQuery.includes(sideB);
    const matchedHasA = matchedText.includes(sideA);
    const matchedHasB = matchedText.includes(sideB);

    // どちらか一方だけを明示的に指しているかどうかを確認する。
    const requirementSide =
      requirementHasA && !requirementHasB
        ? "A"
        : requirementHasB && !requirementHasA
          ? "B"
          : null;

    const matchedSide =
      matchedHasA && !matchedHasB
        ? "A"
        : matchedHasB && !matchedHasA
          ? "B"
          : null;

    if (requirementSide && matchedSide && requirementSide !== matchedSide) {
      return true;
    }

  }

  return false;

}

// =========================
// 5. 指標(売上高/利益/従業員数等)の不一致検出(Rule 5)
// =========================
//
// Requirementが特定の指標を明示的に求めており、Core側の一致候補が
// 別の指標について書かれている場合を検出する。
const METRIC_KEYWORDS: readonly string[] = [
  "売上高",
  "営業利益",
  "経常利益",
  "純利益",
  "利益",
  "従業員数",
  "店舗数",
  "離職率",
];

function detectMetricMismatch(
  requirementQuery: string,
  matchedText: string
): boolean {

  const requirementMetrics = METRIC_KEYWORDS.filter((keyword) =>
    requirementQuery.includes(keyword)
  );

  if (requirementMetrics.length === 0) {
    return false;
  }

  const matchedMetrics = METRIC_KEYWORDS.filter((keyword) =>
    matchedText.includes(keyword)
  );

  if (matchedMetrics.length === 0) {
    return false;
  }

  const hasOverlap = requirementMetrics.some((keyword) =>
    matchedMetrics.includes(keyword)
  );

  return !hasOverlap;

}

// =========================
// checkRequirementSafety (公開API)
// =========================
//
// knowledgeGap.tsのclassifyRequirement()が、status==="covered"と
// 判定した場合にのみ呼び出す想定。safe:falseの場合、呼び出し元は
// statusをpartialへ降格する(missing/covered双方向への変更は
// 呼び出し元の責務とし、ここでは判定のみを行う)。
export function checkRequirementSafety(
  requirementQuery: string,
  matchedText: string
): RequirementSafetyResult {

  const issues: RequirementSafetyIssue[] = [];

  if (
    detectYearMismatch(requirementQuery, matchedText) ||
    detectFreshnessMismatch(requirementQuery, matchedText)
  ) {
    issues.push("time_mismatch");
  }

  if (detectNumericMismatch(requirementQuery, matchedText)) {
    issues.push("numeric_mismatch");
  }

  if (
    detectAttributeMismatch(requirementQuery, matchedText) ||
    detectMetricMismatch(requirementQuery, matchedText)
  ) {
    issues.push("attribute_mismatch");
  }

  return {
    safe: issues.length === 0,
    issues,
  };

}
