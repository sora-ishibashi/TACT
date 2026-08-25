// =========================
// TACT 複数ターンResearch検索クエリの主題継承 Regression (Phase 88)
// =========================
//
// 対象: core/tact-research/queryGeneration.tsのbuildResearchQueries()
// (competitorカテゴリ誤分類の修正)・extractResearchTopic()(新設)、
// core/tact-orchestrator/decomposer.tsのdecomposeTask()(Task.description
// への主題補完配線)、core/tact-conversation/orchestration.tsの
// buildSupplementalResearchQuery()/runSupplementalResearchForArtifact()
// (Turn3補足Researchの主題補完)。
//
// 環境制約(Phase66〜87と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数(decomposeTask()もCapability
// 呼び出しは行わず、Task[]を組み立てるだけ)。

import { buildResearchQueries, extractResearchTopic } from "../../../core/tact-research/queryGeneration";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import { buildSupplementalResearchQuery } from "../../../core/tact-conversation/orchestration";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const turn1Input = "愛知県内の大学生向けスポーツイベントについて調査してください。";
  const turn2Input =
    "さっき調べた内容に、大学生が参加しやすそうなイベントをさらに5件ほど追加で確認してください。特に参加費、定員、開催日、対象年齢など、数字で比較できる情報が確認できるものを優先してください。";
  const turn3Input =
    "ここまで調べたイベントを、イベント名・開催地域・参加費・定員・開催時期・参加対象の6項目で比較表にしてください。数字が確認できない項目は推測せず「確認できず」としてください。最後に、各数値がどの出典に基づくものなのか追跡できる状態にしてください。";

  // ==========================================================
  // Single Turn Regression: previousUserInputが無い単一ターンResearch
  // ==========================================================

  {
    const tasks = decomposeTask({ input: turn1Input });

    results.push(
      check(
        "[SingleTurn-1] previousUserInputが無い場合、Task.descriptionは元のinputのまま(既存挙動を維持)",
        tasks.length === 1 && tasks[0].description === turn1Input && tasks[0].assignedCapability === "research"
      )
    );

    const queries = buildResearchQueries(turn1Input);

    results.push(
      check(
        "[SingleTurn-2] 単一ターンの検索クエリは愛知県・大学生・スポーツイベントの主題を保持する",
        queries.some((q) => q.includes("愛知県") && q.includes("大学生") && q.includes("スポーツイベント"))
      )
    );

  }

  // ==========================================================
  // Multi-turn Research: previousUserInputがTurn2のTask.descriptionへ
  // 主題として補完される
  // ==========================================================

  {
    const tasks = decomposeTask({ input: turn2Input, previousUserInput: turn1Input });

    results.push(
      check(
        "[MultiTurn-1] Turn2のTask.descriptionに、Turn1由来の主題(愛知県/大学生/スポーツイベント)が補完される",
        tasks.length === 1 &&
          tasks[0].assignedCapability === "research" &&
          tasks[0].description.includes("愛知県") &&
          tasks[0].description.includes("大学生") &&
          tasks[0].description.includes("スポーツイベント"),
        `description=${JSON.stringify(tasks[0]?.description)}`
      )
    );

    results.push(
      check(
        "[MultiTurn-2] Turn2自身の追加条件(参加費/定員/開催日/対象年齢/数字で比較できる情報)も" +
          "そのままTask.descriptionに残る(前Turn全文への単純置換ではない)",
        tasks[0].description.includes("参加費") &&
          tasks[0].description.includes("定員") &&
          tasks[0].description.includes("開催日") &&
          tasks[0].description.includes("対象年齢")
      )
    );

    results.push(
      check(
        "[MultiTurn-3] Turn1の全文(「について調査してください。」等の指示句を含む文字列)が" +
          "そのまま連結されるわけではない(トピック抽出であって全文連結ではない)",
        !tasks[0].description.includes("について調査してください"),
        `description=${JSON.stringify(tasks[0].description)}`
      )
    );

    const queries = buildResearchQueries(tasks[0].description);

    results.push(
      check(
        "[MultiTurn-4] Turn2の実際の検索クエリ(buildResearchQueries()の出力)が主題を保持する",
        queries.some((q) => q.includes("愛知県") && q.includes("スポーツイベント")),
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // extractResearchTopic(): 単体テスト
  // ==========================================================

  results.push(
    check(
      "[ExtractTopic-1] 「愛知県内の大学生向けスポーツイベントについて調査してください。2026年に…」から" +
        "「愛知県内の大学生向けスポーツイベント」を抽出する(命令句・後続文を除去)",
      extractResearchTopic(turn1Input) === "愛知県内の大学生向けスポーツイベント",
      `actual=${JSON.stringify(extractResearchTopic(turn1Input))}`
    )
  );

  results.push(
    check(
      "[ExtractTopic-2] 空文字は空文字のまま(捏造しない)",
      extractResearchTopic("") === ""
    )
  );

  // ==========================================================
  // Comparison false positive: 「比較」単体ではcompetitorカテゴリに
  // ならない
  // ==========================================================

  const comparisonFalsePositiveCases: [string, string][] = [
    ["数字で比較できる情報を優先してください", "数字で比較できる情報"],
    ["主要なサービスを5件を比較してください", "5件を比較"],
    ["ここまでの内容を比較表にしてください", "比較表にしてください"],
    ["参加費を比較してください", "参加費を比較"],
    ["開催日を比較してください", "開催日を比較"],
  ];

  for (const [input, label] of comparisonFalsePositiveCases) {

    const queries = buildResearchQueries(input);

    results.push(
      check(
        `[CompetitorFP] 「${label}」はcompetitorカテゴリ(「競合」「価格 比較」の接尾辞付与)にならない`,
        queries.length === 1 && queries[0] === input,
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // Competitor true positive: 本当の競合調査は従来通り機能する
  // ==========================================================

  results.push(
    check(
      "[CompetitorTP-1] 「競合サービスを比較してください」はcompetitorカテゴリとして扱われる(「競合」接尾辞付与)",
      buildResearchQueries("競合サービスを比較してください").some((q) => q.includes("競合サービスを比較してください 競合"))
    )
  );

  results.push(
    check(
      "[CompetitorTP-2] 「競合他社の価格を比較してください」はcompetitorカテゴリとして扱われる(「価格 比較」接尾辞付与)",
      buildResearchQueries("競合他社の価格を比較してください").some((q) =>
        q.includes("競合他社の価格を比較してください 価格 比較")
      )
    )
  );

  results.push(
    check(
      "[CompetitorTP-3] 「他社サービスとの違いを調査してください」は「競合」を含まないためcompetitor" +
        "カテゴリにはならないが(元々の既存挙動)、クエリ自体は破壊されず元の文がそのまま使われる",
      buildResearchQueries("他社サービスとの違いを調査してください").length === 1
    )
  );

  // ==========================================================
  // Multi-turn unrelated topic: 前Turnと無関係な新規Research要求には
  // 主題を混入させない
  // ==========================================================

  {
    const unrelatedTurn1 = "愛知県のスポーツイベントを調査してください";
    const unrelatedTurn2 = "東京のIT企業のインターンについて調べてください";

    const tasks = decomposeTask({ input: unrelatedTurn2, previousUserInput: unrelatedTurn1 });

    results.push(
      check(
        "[Unrelated-1] 「東京のIT企業のインターンについて調べてください」は単独で完結した新規Research要求" +
          "であり、前Turn(愛知県のスポーツイベント)の主題を混入させない",
        tasks.length === 1 &&
          tasks[0].assignedCapability === "research" &&
          tasks[0].description === unrelatedTurn2 &&
          !tasks[0].description.includes("愛知県") &&
          !tasks[0].description.includes("スポーツイベント"),
        `description=${JSON.stringify(tasks[0]?.description)}`
      )
    );

  }

  // ==========================================================
  // Turn3補足Research: buildSupplementalResearchQuery()の主題補完
  // ==========================================================

  {
    const withoutExistingTopic = buildSupplementalResearchQuery(turn3Input);

    results.push(
      check(
        "[Supplemental-1] existingTopic未指定時は既存Phase78〜87と同じ挙動" +
          "(userInput自身から抽出したtopicのみを使う、後方互換)",
        !withoutExistingTopic.includes("愛知県"),
        `query=${JSON.stringify(withoutExistingTopic)}`
      )
    );

    const withExistingTopic = buildSupplementalResearchQuery(
      turn3Input,
      "愛知県内の大学生向けスポーツイベント"
    );

    results.push(
      check(
        "[Supplemental-2] existingTopic(既存Artifact.title)を渡すと、Turn3の補足Researchクエリに" +
          "愛知県・スポーツイベントという主題が補完される(Phase87 Root Cause: Turn3自身の文面には" +
          "「ここまで調べたイベント」という文脈依存の指示語しか無く主題を失っていた問題の修正)",
        withExistingTopic.includes("愛知県") && withExistingTopic.includes("スポーツイベント"),
        `query=${JSON.stringify(withExistingTopic)}`
      )
    );

    results.push(
      check(
        "[Supplemental-3] 補足Researchクエリは引き続きRESEARCH_PATTERNに確実に一致する語尾" +
          "(「について調査してください」)を持つ(既存契約を維持)",
        withExistingTopic.endsWith("について調査してください")
      )
    );

  }

  // ==========================================================
  // 3ターンRegression(Phase87実機Reality Testの文言そのもの、
  // decomposeTask()経由の本番配線と同じ経路で検証)
  // ==========================================================

  {

    const turn1Tasks = decomposeTask({ input: turn1Input });

    results.push(
      check(
        "[3Turn-Turn1] Turn1はassignedCapability='research'(既存挙動)",
        turn1Tasks.length === 1 && turn1Tasks[0].assignedCapability === "research"
      )
    );

    const turn2Tasks = decomposeTask({ input: turn2Input, previousUserInput: turn1Input });

    results.push(
      check(
        "[3Turn-Turn2] Turn2はassignedCapability='research'かつ、実際の検索クエリに愛知県/大学生/" +
          "スポーツイベントの主題が保持される(Phase87で実際に0件だった問題の再現・修正確認)",
        turn2Tasks.length === 1 &&
          turn2Tasks[0].assignedCapability === "research" &&
          buildResearchQueries(turn2Tasks[0].description).some(
            (q) => q.includes("愛知県") && q.includes("スポーツイベント")
          ),
        `description=${JSON.stringify(turn2Tasks[0]?.description)}`
      )
    );

    const turn3Tasks = decomposeTask({ input: turn3Input, previousUserInput: turn2Input });

    results.push(
      check(
        "[3Turn-Turn3] Turn3はTable/Comparison要求でありResearch Capabilityを必要としない" +
          "(既存設計通り、Phase85/86のTurn3挙動を壊さない)",
        turn3Tasks.length === 1 && turn3Tasks[0].assignedCapability === undefined
      )
    );

    const turn3SupplementalQuery = buildSupplementalResearchQuery(
      turn3Input,
      "愛知県内の大学生向けスポーツイベント"
    );

    results.push(
      check(
        "[3Turn-Turn3-Supplemental] Turn3の補足Research(needsSupplementalResearchForArtifact()が" +
          "trueを返すケース)でも、既存Artifact.titleを渡せば主題を保持したクエリになる",
        turn3SupplementalQuery.includes("愛知県") && turn3SupplementalQuery.includes("スポーツイベント")
      )
    );

  }

  return summarize("multi-turn research query topic continuation (Phase 88)", results);

}
