import type { PresentationType } from "./types";

export type PresentationIntent = PresentationType | "chart";

const EXPLANATION = /(?:とは|って何|使い方|について説明|意味)/i;
const TABLE = /(?:表|テーブル|table)/i;
const BAR = /(?:棒グラフ|bar\s*chart|bar-chart)/i;
const LINE = /(?:折れ線グラフ|line\s*chart|line-chart)/i;
const CHART = /(?:グラフ|chart)/i;
const ACTION = /(?:にして|化して|作って|作成して|表示して|見せて|出して)/i;

/** Precision-first: conceptual chart questions never request Artifact presentation. */
export function detectPresentationIntent(userInput: string): PresentationIntent | undefined {
  const input = userInput.trim();
  if (!input || EXPLANATION.test(input)) return undefined;
  if (LINE.test(input) && ACTION.test(input)) return "line-chart";
  if (BAR.test(input) && ACTION.test(input)) return "bar-chart";
  if (TABLE.test(input) && ACTION.test(input)) return "table";
  if (CHART.test(input) && ACTION.test(input)) return "chart";
  return undefined;
}
