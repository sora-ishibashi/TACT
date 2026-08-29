import type { CalculationIntent } from "./types";
import type { RankingDirection } from "../calculation/types";

const ACTION = /(計算|算出|求め|出して|出す|並べ|ランキング|順位|ランク|比較)/i;
const DEFINITIONS = /(?:とは|って何|について説明|意味|definition)/i;

function matchesCagr(input: string): boolean {
  return /\bCAGR\b|年平均成長率/i.test(input) && ACTION.test(input);
}

function matchesGrowthRate(input: string): boolean {
  return /(成長率|増加率|減少率|前年比.*(?:増減率|変化率)|増減率)/.test(input) && ACTION.test(input);
}

function matchesPercentage(input: string): boolean {
  return /(割合|構成比|何パーセント|何%)/.test(input) &&
    (ACTION.test(input) || /何パーセント|何%/.test(input));
}

function matchesRanking(input: string): boolean {
  return /(ランキング|順位|大きい順|小さい順|高い順|低い順|売上順|価格順|数量順)/.test(input) &&
    /(並べ|ランキング|順位|ランク|順に|上位|下位|比較)/.test(input);
}

/**
 * Precision-first intent gate. A conceptual request such as "CAGRとは" is
 * intentionally not a calculation request, even though it contains a keyword.
 */
export function detectCalculationIntent(userInput: string): CalculationIntent | undefined {
  const input = userInput.trim();

  if (!input || DEFINITIONS.test(input)) {
    return undefined;
  }

  const matches: CalculationIntent[] = [];

  if (matchesCagr(input)) matches.push("cagr");
  if (matchesGrowthRate(input)) matches.push("growth-rate");
  if (matchesPercentage(input)) matches.push("percentage");
  if (matchesRanking(input)) matches.push("ranking");

  return matches.length === 1 ? matches[0] : undefined;
}

export function detectRankingDirection(userInput: string): RankingDirection {
  return /小さい順|低い順|昇順/.test(userInput) ? "ascending" : "descending";
}
