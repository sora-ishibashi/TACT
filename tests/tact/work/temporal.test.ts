// =========================
// TACT Work — Temporal State Foundation Regression (TIME-P1a)
// =========================
//
// 対象: core/tact-work/temporal.tsのisDeadlineExceeded()/
// isWaitUntilSatisfied()/isRetryTimeSatisfied()。いずれも純粋関数
// (DB/LLM/Search API呼び出みは0件、内部でnew Date()/Date.now()を
// 一切呼ばない——常に呼び出し元が渡すnow: Dateだけを使う)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isDeadlineExceeded,
  isWaitUntilSatisfied,
  isRetryTimeSatisfied,
} from "../../../core/tact-work/temporal";
import { check, summarize, type CheckResult } from "../lib/check";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const PAST = "2026-10-10T11:00:00.000Z";
const FUTURE = "2026-10-10T13:00:00.000Z";
const EXACTLY_NOW = "2026-10-10T12:00:00.000Z";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- isDeadlineExceeded(Section6): pastは超過、futureは未超過、
  // 境界(now===deadline)は超過(>=)、未設定/不正値は超過していない
  // (fail safe、overdue policyを勝手に発動しない) ----

  results.push(check("[deadline] 過去のdeadline -> exceeded(true)", isDeadlineExceeded(NOW, PAST) === true));
  results.push(check("[deadline] 未来のdeadline -> not exceeded(false)", isDeadlineExceeded(NOW, FUTURE) === false));
  results.push(check("[deadline] 境界(now===deadline) -> exceeded(true、>=境界)", isDeadlineExceeded(NOW, EXACTLY_NOW) === true));
  results.push(check("[deadline] 未設定(null) -> not exceeded(false)", isDeadlineExceeded(NOW, null) === false));
  results.push(check("[deadline] 未設定(undefined) -> not exceeded(false)", isDeadlineExceeded(NOW, undefined) === false));
  results.push(check('[deadline] 不正な文字列("not-a-date") -> not exceeded(false、fail safe)', isDeadlineExceeded(NOW, "not-a-date") === false));

  // ---- isWaitUntilSatisfied(Section7): pastは満たされている、futureは
  // 満たされていない、境界は満たされている(>=)、未設定/不正値は
  // 「gateなし」= 満たされている(fail safeの方向がdeadlineとは逆) ----

  results.push(check("[waitUntil] 過去のwaitUntil -> satisfied(true、gate already open)", isWaitUntilSatisfied(NOW, PAST) === true));
  results.push(check("[waitUntil] 未来のwaitUntil -> not satisfied(false)", isWaitUntilSatisfied(NOW, FUTURE) === false));
  results.push(check("[waitUntil] 境界(now===waitUntil) -> satisfied(true、>=境界)", isWaitUntilSatisfied(NOW, EXACTLY_NOW) === true));
  results.push(check("[waitUntil] 未設定(null) -> satisfied(true、gateなし)", isWaitUntilSatisfied(NOW, null) === true));
  results.push(check("[waitUntil] 未設定(undefined) -> satisfied(true)", isWaitUntilSatisfied(NOW, undefined) === true));
  results.push(check('[waitUntil] 不正な文字列 -> satisfied(true、fail safe: gateとして機能しない値で永久に足止めしない)', isWaitUntilSatisfied(NOW, "not-a-date") === true));

  // ---- isRetryTimeSatisfied(Section8/12): pastは満たされている、
  // futureは満たされていない、境界は満たされている(>=)、未設定は
  // 「時間による制約なし」= 満たされている(Section12の明示的preferred
  // default) ----

  results.push(check("[nextRetryAt] 過去のnextRetryAt -> satisfied(true)", isRetryTimeSatisfied(NOW, PAST) === true));
  results.push(check("[nextRetryAt] 未来のnextRetryAt -> not satisfied(false)", isRetryTimeSatisfied(NOW, FUTURE) === false));
  results.push(check("[nextRetryAt] 境界(now===nextRetryAt) -> satisfied(true、>=境界)", isRetryTimeSatisfied(NOW, EXACTLY_NOW) === true));
  results.push(check("[nextRetryAt] 未設定(null) -> satisfied(true、Section12の明示的preferred default: 時間による制約なし)", isRetryTimeSatisfied(NOW, null) === true));
  results.push(check("[nextRetryAt] 未設定(undefined) -> satisfied(true)", isRetryTimeSatisfied(NOW, undefined) === true));
  results.push(check('[nextRetryAt] 不正な文字列 -> satisfied(true、fail safe)', isRetryTimeSatisfied(NOW, "not-a-date") === true));

  // ---- 絶対条件(Section19、最重要): 時間的判定の結果はauthorizationの
  // 代替にならない——これら3関数の戻り値の型自体がbooleanのみであり、
  // Approval/Policy/Capability selection相当の情報(承認可否・
  // provider action・integrity検証結果)を一切運ばないことの直接確認 ----

  results.push(
    check(
      "[絶対条件Section19] isWaitUntilSatisfied()/isRetryTimeSatisfied()/isDeadlineExceeded()はいずれもbooleanだけを返し、Approval/Policy/Capability相当の情報を一切運ばない",
      typeof isWaitUntilSatisfied(NOW, PAST) === "boolean" &&
        typeof isRetryTimeSatisfied(NOW, PAST) === "boolean" &&
        typeof isDeadlineExceeded(NOW, PAST) === "boolean"
    )
  );

  // ---- 絶対条件(Section18、決定論性): このfile自身がnew Date()/
  // Date.now()を一切呼ばない(常に引数nowだけを使う)ことのsource-level
  // 構造的証拠 ----
  {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "temporal.ts"),
      "utf-8"
    );

    // コメント中の言及(絶対条件の説明文)を除外し、実コード行だけを対象にする。
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    results.push(
      check(
        "[絶対条件Section18] core/tact-work/temporal.tsは実コード中でnew Date()/Date.now()を一切呼ばない(常に引数nowを使う、決定論的なtestを可能にする構造的証拠)",
        !codeLines.includes("new Date()") && !codeLines.includes("Date.now()")
      )
    );
  }

  return summarize("work/temporal", results);

}
