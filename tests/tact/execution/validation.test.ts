// =========================
// TACT Canonical Execution — Validation Regression (SOR-50)
// =========================
//
// 対象: core/tact-execution/validation.tsのvalidateCaptureExecutionInput()
// /findSuspiciousExecutionMetadataKeys()(いずれも純粋関数、DBアクセス
// なし)。SOR-50 Tests要件の「正常なexternal event」「必須値欠落」
// 「unknown provider/action」「timestamp handling」をここで検証する
// (duplicate/tenant boundary/DB persistenceはstore.test.tsで扱う)。

import {
  validateCaptureExecutionInput,
  findSuspiciousExecutionMetadataKeys,
} from "../../../core/tact-execution/validation";
import type { CaptureExecutionInput } from "../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../lib/check";

function baseInput(overrides: Partial<CaptureExecutionInput> = {}): CaptureExecutionInput {
  return {
    userId: "user-1",
    actorKind: "human",
    actorId: "U123",
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev123",
    adapterVersion: "slack-app-mention-v1",
    actionCategory: "create",
    operation: "app_mention",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常なexternal event -> valid ----
  {
    const result = validateCaptureExecutionInput(baseInput());

    results.push(check("[Test1] 正常なinputはok=true", result.ok === true));
  }

  // ---- Test2: 必須値欠落 ----
  {
    const result = validateCaptureExecutionInput(
      baseInput({ externalEventId: "", operation: "" })
    );

    results.push(
      check(
        "[Test2] externalEventId/operation欠落はok=falseかつ両方を報告する",
        result.ok === false &&
          result.errors.some((e) => e.includes("externalEventId")) &&
          result.errors.some((e) => e.includes("operation"))
      )
    );
  }

  // ---- Test3: unknown provider/action ----
  {
    const result = validateCaptureExecutionInput(
      baseInput({
        provider: "unknown_provider" as unknown as CaptureExecutionInput["provider"],
        actionCategory: "delete_everything" as unknown as CaptureExecutionInput["actionCategory"],
      })
    );

    results.push(
      check(
        "[Test3] unknown provider/actionCategoryはok=falseを返す(fail closed)",
        result.ok === false &&
          result.errors.some((e) => e.includes("provider")) &&
          result.errors.some((e) => e.includes("actionCategory"))
      )
    );
  }

  // ---- Test4: timestamp handling ----
  {
    const okResult = validateCaptureExecutionInput(
      baseInput({ providerOccurredAt: "2026-09-20T00:00:00.000Z" })
    );

    results.push(
      check(
        "[Test4a] 明示的timezone付きtimestampは受理する",
        okResult.ok === true
      )
    );

    const ambiguousResult = validateCaptureExecutionInput(
      baseInput({ providerOccurredAt: "2026-09-20T00:00:00" as string })
    );

    results.push(
      check(
        "[Test4b] timezone無しの曖昧なtimestampは拒否する(外部時刻をYolna受信時刻として扱わない)",
        ambiguousResult.ok === false
      )
    );
  }

  // ---- Test5: unknown provider/action = failed executionのerrorMessage長さ制限 ----
  {
    const result = validateCaptureExecutionInput(
      baseInput({ status: "failed", errorMessage: "x".repeat(2001) })
    );

    results.push(
      check(
        "[Test5] errorMessageが2000文字を超える場合は拒否する",
        result.ok === false && result.errors.some((e) => e.includes("errorMessage"))
      )
    );
  }

  // ---- Test6: sourceMetadataの疑わしいkey名guard ----
  {
    const suspicious = findSuspiciousExecutionMetadataKeys({
      channel: "C1",
      nested: { access_token: "should-not-be-here" },
    });

    results.push(
      check(
        "[Test6a] findSuspiciousExecutionMetadataKeys(): ネストしたtoken系keyを検出する",
        suspicious.some((k) => k.includes("access_token"))
      )
    );

    const result = validateCaptureExecutionInput(
      baseInput({ sourceMetadata: { authorization: "Bearer xyz" } })
    );

    results.push(
      check(
        "[Test6b] sourceMetadataに疑わしいkeyが含まれる場合、captureExecution前に拒否する",
        result.ok === false && result.errors.some((e) => e.includes("sourceMetadata"))
      )
    );
  }

  return summarize("TACT Canonical Execution — Validation", results);

}
