// =========================
// TACT Canonical Execution — Outcome Validation Regression (SOR-119)
// =========================
//
// 対象: core/tact-execution/outcome/validation.tsのvalidateAssertExecutionOutcomeInput()
// (純粋関数、DBアクセスなし)。

import { validateAssertExecutionOutcomeInput } from "@tact/runs-core/tact-execution/outcome/validation";
import type { AssertExecutionOutcomeInput } from "@tact/runs-core/tact-execution/outcome/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseInput(overrides: Partial<AssertExecutionOutcomeInput> = {}): AssertExecutionOutcomeInput {
  return {
    executionId: "exec-1",
    status: "asserted",
    outcomeKind: "page_updated",
    method: "adapter_asserted",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常なasserted入力 -> valid ----
  {
    const result = validateAssertExecutionOutcomeInput(baseInput());

    results.push(check("[Test1] 正常なasserted入力はok=true", result.ok === true));
  }

  // ---- Test2: 正常なunknown入力(outcomeKind省略) -> valid ----
  {
    const result = validateAssertExecutionOutcomeInput(
      baseInput({ status: "unknown", outcomeKind: undefined })
    );

    results.push(
      check(
        "[Test2] status='unknown'かつoutcomeKind省略はok=true(確認したが判断できない、正常な状態)",
        result.ok === true
      )
    );
  }

  // ---- Test3 (絶対条件、Never Guess Rule): asserted状態でoutcomeKind欠落は拒否 ----
  {
    const result = validateAssertExecutionOutcomeInput(baseInput({ outcomeKind: undefined }));

    results.push(
      check(
        "[Test3] status='asserted'なのにoutcomeKind欠落はok=falseを返す(fail closed)",
        result.ok === false && result.errors.some((e) => e.includes("outcomeKind"))
      )
    );
  }

  // ---- Test4 (絶対条件、Never Guess Rule): unknown状態でoutcomeKindが設定されていたら拒否 ----
  {
    const result = validateAssertExecutionOutcomeInput(
      baseInput({ status: "unknown", outcomeKind: "page_updated" })
    );

    results.push(
      check(
        "[Test4] status='unknown'なのにoutcomeKindが設定されているとok=falseを返す(判断できないものへ値を埋めない)",
        result.ok === false && result.errors.some((e) => e.includes("outcomeKind"))
      )
    );
  }

  // ---- Test5: 必須値欠落(executionId) ----
  {
    const result = validateAssertExecutionOutcomeInput(baseInput({ executionId: "" }));

    results.push(
      check(
        "[Test5] executionId欠落はok=falseを返す",
        result.ok === false && result.errors.some((e) => e.includes("executionId"))
      )
    );
  }

  // ---- Test6: unknown status/method ----
  {
    const result = validateAssertExecutionOutcomeInput(
      baseInput({
        status: "maybe" as unknown as AssertExecutionOutcomeInput["status"],
        method: "ai_guessed" as unknown as AssertExecutionOutcomeInput["method"],
      })
    );

    results.push(
      check(
        "[Test6] 未知のstatus/methodはok=falseを返す(fail closed)",
        result.ok === false &&
          result.errors.some((e) => e.includes("status")) &&
          result.errors.some((e) => e.includes("method"))
      )
    );
  }

  // ---- Test7: summary長さ制限 ----
  {
    const result = validateAssertExecutionOutcomeInput(baseInput({ summary: "x".repeat(501) }));

    results.push(
      check(
        "[Test7] summaryが500文字を超える場合は拒否する",
        result.ok === false && result.errors.some((e) => e.includes("summary"))
      )
    );
  }

  // ---- Test8: metadataの疑わしいkey名guard ----
  {
    const result = validateAssertExecutionOutcomeInput(
      baseInput({ metadata: { nested: { access_token: "should-not-be-here" } } })
    );

    results.push(
      check(
        "[Test8] metadataに疑わしいkeyが含まれる場合は拒否する",
        result.ok === false && result.errors.some((e) => e.includes("metadata"))
      )
    );
  }

  // ---- Test9: manual_override methodも正常に受理する(human correction経路) ----
  {
    const result = validateAssertExecutionOutcomeInput(
      baseInput({ method: "manual_override", reasonCode: "human_reviewed_and_corrected" })
    );

    results.push(
      check(
        "[Test9] method='manual_override'(human correction)も正常に受理する",
        result.ok === true
      )
    );
  }

  return summarize("SOR-119 — Canonical Execution Outcome Validation", results);

}
