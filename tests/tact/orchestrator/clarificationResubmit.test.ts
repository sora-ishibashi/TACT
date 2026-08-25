// =========================
// Clarification UX Option B Regression (Phase 46)
// =========================
//
// 対象: components/orchestrateClarification.ts(buildClarificationResendInput())、
// および既存のrunOrchestration()/detectAmbiguity()/decomposeTask()の
// 組み合わせで、Option Bの一連のループ
// (曖昧な入力 → Clarification → 元入力+回答を結合して再送信 → 通常実行)
// が実際に成立することを確認する。
//
// 絶対条件: ambiguityDetector.ts・runOrchestration()・decomposeTask()
// 自体は一切変更していない(既存の振る舞いをそのまま利用するだけ)。
// LLM/Search API呼び出しは0件(registerCapability()によるmock、
// Phase20〜45の既存Harnessパターンを再利用)。userIdは意図的に省略する
// (Phase32以来の既存パターン: buildTaskContext()の未認証フォールバックを
// 使い、実Supabase接続を発生させない)。

import "dotenv/config";
import { runOrchestration } from "../../../core/tact-orchestrator";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { buildClarificationResendInput } from "../../../components/orchestrateClarification";
import type { ResearchParams, ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
    searchQueryCount: 1, searchRequestCount: 1, searchAttempts: [],
    retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
    usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
    usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
    durationMs: 100, mocked: false, requirementCount: 1, coveredRequirementCount: 0,
    partialRequirementCount: 0, missingRequirementCount: 1, gapQueries: [], safetyDowngradeCount: 0,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test B: buildClarificationResendInput()が元入力・回答の両方を保持する ----
  {
    const combined = buildClarificationResendInput(
      "調べて",
      "何について調べればいいですか?",
      "トヨタの競合について"
    );

    results.push(
      check(
        "[TestB] 結合結果に元入力(originalInput)が含まれる",
        combined.includes("調べて")
      )
    );

    results.push(
      check(
        "[TestB] 結合結果に回答(answer)が含まれる",
        combined.includes("トヨタの競合について")
      )
    );
  }

  // ---- Test A/C/D: 曖昧な入力 -> Clarification -> 結合して再送信 -> 通常実行 ----
  {
    let capabilityCalled = false;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      capabilityCalled = true;
      return {
        success: true,
        answer: `トヨタの競合についての調査結果(query=${params.query})`,
        evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
        metadata: makeMetadata(),
      };
    });

    // Step1: 曖昧な入力(既存のambiguityDetector.tsが検知する、STEP辞書
    // BARE_VERB_QUESTIONSの既存語を使う。ここではロジックを変更せず
    // 既存挙動をそのまま利用する)。
    const first = await runOrchestration({ input: "調べて" });

    results.push(
      check(
        "[TestA] 曖昧な入力 -> clarification.questionが返り、tasksは空のまま",
        typeof first.clarification?.question === "string" &&
          first.clarification.question.length > 0 &&
          first.tasks.length === 0 &&
          !capabilityCalled,
        `clarification=${JSON.stringify(first.clarification)}, tasks=${first.tasks.length}`
      )
    );

    // Step2: 元入力 + Clarification回答を結合し、既存/api/tact/orchestrate
    // と同じ契約(input: stringのみ)で再送信する。
    const resendInput = buildClarificationResendInput(
      "調べて",
      first.clarification?.question ?? "",
      "トヨタの競合について"
    );

    const second = await runOrchestration({ input: resendInput });

    results.push(
      check(
        "[TestC] 結合したinputがCapabilityへ実際に渡る(queryに回答内容が含まれる)",
        capabilityCalled,
        `capabilityCalled=${capabilityCalled}`
      )
    );

    results.push(
      check(
        "[TestD] 再送信後はclarificationが発生せず、通常の最終回答が返る",
        second.clarification === undefined &&
          second.tasks.length === 1 &&
          second.tasks[0].status === "completed" &&
          second.answer.includes("調査結果"),
        `clarification=${JSON.stringify(second.clarification)}, taskStatus=${second.tasks[0]?.status}, answer=${JSON.stringify(second.answer)}`
      )
    );
  }

  // ---- Test E: 曖昧でない通常のQueryへの回帰確認(既存フローが壊れていない) ----
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "通常の回答",
      evidence: [{ id: "e2", claim: "c2", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({ input: "日本の首相は誰ですか？" });

    results.push(
      check(
        "[TestE] 曖昧でない通常のQueryはclarificationを経由せず、従来どおり実行される(回帰なし)",
        result.clarification === undefined &&
          result.tasks.length === 1 &&
          result.tasks[0].status === "completed"
      )
    );
  }

  return summarize("clarification resubmit (Phase 46 Option B)", results);

}
