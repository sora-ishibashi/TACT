// =========================
// resolveModelRouting Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/modelRouter.ts の resolveModelRouting()。
// 純粋関数(Taskの値だけから決定論的に解決)のため、Category Aとして
// 実LLM/API呼び出み無しで検証できる。Phase7で確立済みのProvider/Model
// 不整合検出(core/llm/pricing.tsを根拠にした実データ照合)を恒久test
// へ移した。

import { resolveModelRouting } from "../../../core/tact-orchestrator/modelRouter";
import type { Task } from "../../../core/tact-orchestrator/task";
import { check, summarize, type CheckResult } from "../lib/check";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    description: "テスト",
    status: "pending",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Provider/Model未指定 -> TACT既定(openai)で成功 ----
  {
    const outcome = resolveModelRouting(baseTask());
    results.push(
      check(
        "[Phase7] Provider/Model未指定 -> success, provider=openai(既定)",
        outcome.success === true && outcome.success && outcome.provider === "openai",
        JSON.stringify(outcome)
      )
    );
  }

  // ---- researchはcapability既定Provider(openai)を使う ----
  {
    const outcome = resolveModelRouting(baseTask({ assignedCapability: "research" }));
    results.push(
      check(
        "[Phase7] assignedCapability=research -> capability既定Providerで成功",
        outcome.success === true,
        JSON.stringify(outcome)
      )
    );
  }

  // ---- Provider/Model確定的不整合 -> 実行前に失敗(0コスト) ----
  {
    const outcome = resolveModelRouting(
      baseTask({ assignedProvider: "openai", assignedModel: "claude-haiku-4-5-20251001" })
    );
    results.push(
      check(
        "[Phase7] openai + claude専用モデル -> 確定的Provider/Model不整合でfailed",
        outcome.success === false,
        JSON.stringify(outcome)
      )
    );
  }

  // ---- gemini(未実装Provider) -> failed ----
  {
    const outcome = resolveModelRouting(baseTask({ assignedProvider: "gemini" }));
    results.push(
      check(
        "[Phase7] assignedProvider=gemini(未実装) -> failed",
        outcome.success === false,
        JSON.stringify(outcome)
      )
    );
  }

  return summarize("resolveModelRouting", results);

}
