// =========================
// Failure Classification & Retry Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/executor.ts の isTemporaryFailure() /
// withTemporaryFailureRetry()(Phase19、Phase20でexport化)。
// Phase19のReality Testをそのまま恒久testへ移した。
//
// Category A/B境界: isTemporaryFailure()はDeterministic(A)。
// withTemporaryFailureRetry()はmockのattempt関数を使うMock-based(B)
// (実LLM/実APIは一切呼ばない)。

import {
  isTemporaryFailure,
  withTemporaryFailureRetry,
} from "../../../core/tact-orchestrator/executor";
import { LLMProviderError } from "../../../core/llm/types";
import type { LLMProviderFailureReason } from "../../../core/llm/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Step2: A(一時的)/B(永続的)/C(分類不能)の分類 ----

  const reasonCases: { reason: LLMProviderFailureReason; expectedRetry: boolean }[] = [
    { reason: "network_error", expectedRetry: true },
    { reason: "rate_limited", expectedRetry: true },
    { reason: "quota_exceeded", expectedRetry: false },
    { reason: "authentication_failed", expectedRetry: false },
    { reason: "invalid_request", expectedRetry: false },
    { reason: "unknown_error", expectedRetry: false },
  ];

  for (const c of reasonCases) {

    const err = new LLMProviderError("openai", c.reason, `mock ${c.reason}`);

    results.push(
      check(
        `[Phase19] isTemporaryFailure(reason=${c.reason}) -> ${c.expectedRetry}`,
        isTemporaryFailure(err) === c.expectedRetry
      )
    );

  }

  results.push(
    check(
      "[Phase19] isTemporaryFailure(plain Error, capability not found等) -> false",
      isTemporaryFailure(new Error('Capability "x" is not registered.')) === false
    )
  );

  // ---- Step3: Retryラッパーの挙動(mock attempt、実API呼び出み0件) ----

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      if (calls === 1) {
        throw new LLMProviderError("openai", "rate_limited", "mock rate limit");
      }
      return "ok";
    };
    const { result, retried } = await withTemporaryFailureRetry(attempt);
    results.push(
      check(
        "[Phase19-8] temporary failure -> retry succeeds (max 1 retry, +1 call)",
        calls === 2 && retried === true && result === "ok",
        `calls=${calls}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new LLMProviderError("openai", "network_error", `mock #${calls}`);
    };
    let threw = false;
    let message = "";
    try {
      await withTemporaryFailureRetry(attempt);
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    results.push(
      check(
        "[Phase19-9] temporary failure x2 -> fails after exactly 2 attempts, both reasons kept",
        threw && calls === 2 && message.includes("#1") && message.includes("#2"),
        `calls=${calls}, message=${message}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new LLMProviderError("openai", "quota_exceeded", "mock quota");
    };
    let threw = false;
    try {
      await withTemporaryFailureRetry(attempt);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[Quota] quota_exceeded -> NOT retried (calls=1)",
        threw && calls === 1,
        `calls=${calls}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new LLMProviderError("openai", "authentication_failed", "mock auth");
    };
    let threw = false;
    try {
      await withTemporaryFailureRetry(attempt);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[Phase19-10] authentication_failed -> NOT retried (calls=1)",
        threw && calls === 1,
        `calls=${calls}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new LLMProviderError("openai", "invalid_request", "mock invalid request");
    };
    let threw = false;
    try {
      await withTemporaryFailureRetry(attempt);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[Phase19-11] invalid_request -> NOT retried (calls=1)",
        threw && calls === 1,
        `calls=${calls}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new Error("unexpected runtime error");
    };
    let threw = false;
    try {
      await withTemporaryFailureRetry(attempt);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[Phase19-12] unknown/unclassified error -> NOT retried (calls=1)",
        threw && calls === 1,
        `calls=${calls}`
      )
    );
  }

  {
    let calls = 0;
    const attempt = async () => {
      calls++;
      return "ok";
    };
    const { result, retried } = await withTemporaryFailureRetry(attempt);
    results.push(
      check(
        "[Phase19] normal success -> 0 extra calls",
        calls === 1 && retried === false && result === "ok",
        `calls=${calls}`
      )
    );
  }

  return summarize("failureClassification/retry", results);

}
