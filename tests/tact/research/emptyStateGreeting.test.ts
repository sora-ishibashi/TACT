import { getEmptyStateGreetingPeriod } from "../../../components/research/ResearchWorkspace";
import { check, summarize, type CheckResult } from "../lib/check";

const greetingPeriodCases = [
  [0, "lateNight"],
  [1, "lateNight"],
  [4, "lateNight"],
  [5, "morning"],
  [10, "morning"],
  [11, "midday"],
  [13, "midday"],
  [14, "afternoon"],
  [17, "afternoon"],
  [18, "evening"],
  [22, "evening"],
  [23, "lateNight"],
] as const;

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = greetingPeriodCases.map(([hour, expected]) => {
    const actual = getEmptyStateGreetingPeriod(hour);
    return check(
      `getEmptyStateGreetingPeriod(${hour}) returns ${expected}`,
      actual === expected,
      `actual=${actual}`
    );
  });

  return summarize("research empty state greeting periods", results);
}
