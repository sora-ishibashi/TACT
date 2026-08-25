// =========================
// TACT 追加Research Intent判定 Regression (Phase 86)
// =========================
//
// 対象: core/tact-intent/ruleRouter.tsのclassifyIntent()(追加Research
// 要求・Conversation Context利用による継続要求の判定を追加)、
// core/tact-orchestrator/decomposer.tsのdecomposeTask()
// (OrchestrationRequest.previousUserInputの配線)。
//
// 環境制約(Phase66〜85と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数(decomposeTask()もCapability
// 呼び出しは行わず、Task[]を組み立てるだけ)。

import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Section4: 明示的追加Research(単独で判定可能、Contextなし)
  // ==========================================================

  const explicitAdditionalCases: [string, string][] = [
    ["追加で5件調べて", "追加で5件調べて"],
    ["追加で5件確認して", "追加で5件確認して"],
    ["さらに3件調べて", "さらに3件調べて"],
    ["具体例を5件追加して", "具体例を5件追加して(Phase82-C経由)"],
    ["他にも5件探して", "他にも5件探して"],
    ["別の事例も調べて", "別の事例も調べて"],
  ];

  for (const [input, label] of explicitAdditionalCases) {

    results.push(
      check(
        `[Explicit] 「${label}」-> research(Contextなしで単独判定)`,
        classifyIntent(input).intent === "research",
        `decision=${JSON.stringify(classifyIntent(input))}`
      )
    );

  }

  // ==========================================================
  // Section4: 直前Researchを引き継ぐ継続要求(Conversation Context必須)
  // ==========================================================

  const researchPrevious = "愛知県内のスポーツイベントについて調査してください";
  const chatPrevious = "今日はいい天気ですね";

  results.push(
    check(
      "[Continuation-1] 「もう少し事例を増やしてください」+ 直前がresearch -> research",
      classifyIntent("もう少し事例を増やしてください", researchPrevious).intent === "research"
    )
  );

  results.push(
    check(
      "[Continuation-2] 「別のイベントも見つけてください」+ 直前がresearch -> research",
      classifyIntent("別のイベントも見つけてください", researchPrevious).intent === "research"
    )
  );

  results.push(
    check(
      "[Continuation-3] 同じ文面でも、直前が存在しない(単独) -> research継続パターンには一致せず、chatのまま" +
        "(汎用動詞「見つけて」「増やして」を無条件にResearchへ広げない、絶対条件)",
      classifyIntent("もう少し事例を増やしてください").intent === "chat" &&
        classifyIntent("別のイベントも見つけてください").intent === "chat"
    )
  );

  results.push(
    check(
      "[Continuation-4] 同じ文面でも、直前Turnがresearchでない(雑談) -> chatのまま" +
        "(Conversation Contextの中身を見ずに継続要求と誤判定しない)",
      classifyIntent("もう少し事例を増やしてください", chatPrevious).intent === "chat" &&
        classifyIntent("別のイベントも見つけてください", chatPrevious).intent === "chat"
    )
  );

  // ==========================================================
  // Section5・7: False Positive確認(一般語単体・雑談・整形依頼等)
  // ==========================================================

  const falsePositiveCases: [string, string][] = [
    ["この中でどれを優先すべき？", "優先単体"],
    ["どれがおすすめ？", "おすすめ単体"],
    ["一番いいのはどれ？", "一番いい"],
    ["さっきの内容を短くして", "さっきの(さらにと誤認しない)"],
    ["表にして", "表にして単体"],
    ["文章を整理して", "整理して単体"],
    ["この結果についてどう思う？", "感想質問"],
    ["ありがとう", "雑談"],
    ["それってどういう意味？", "定義質問"],
  ];

  for (const [input, label] of falsePositiveCases) {

    results.push(
      check(
        `[FalsePositive] 「${label}」-> researchにならない`,
        classifyIntent(input).intent !== "research",
        `decision=${JSON.stringify(classifyIntent(input))}`
      )
    );

  }

  // 「確認」「教えて」「おすすめ」という語が単体で含まれるだけでは
  // researchにしない、という絶対条件そのものを直接確認する。
  results.push(
    check(
      "[FalsePositive-単語単体] 「確認」「教えて」「おすすめ」を含むだけの一般的な文はresearchにならない",
      classifyIntent("内容を確認しました").intent !== "research" &&
        classifyIntent("やり方を教えて").intent !== "research" &&
        classifyIntent("おすすめは何ですか").intent !== "research"
    )
  );

  // ==========================================================
  // Section6: 3ターンRegression Scenario(実際のdecomposeTask()経由、
  // OrchestrationRequest.previousUserInputの配線を含めて検証する)
  // ==========================================================

  const turn1Input =
    "愛知県内で、大学生が参加しやすいスポーツイベントについて調査してください。具体的なイベントを中心に調べてください。";
  const turn2Input =
    "大学3〜4年生が実際に参加しやすそうなものを5件ほど追加で確認してください。確認できるものを優先してください。";
  const turn3Input =
    "ここまで確認したイベントを、イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較表にしてください。各行がどのEvidenceを根拠にしているのか追跡できる状態にしてください。";

  {

    // Turn1: previousUserInput未指定(会話の最初のTurn)。
    const turn1Tasks = decomposeTask({ input: turn1Input });

    results.push(
      check(
        "[Scenario-Turn1] decomposeTask()経由でTurn1がassignedCapability='research'になる",
        turn1Tasks.length === 1 && turn1Tasks[0].assignedCapability === "research"
      )
    );

    // Turn2: OrchestrationRequest.previousUserInputにTurn1の入力を渡す
    // (実際にcore/tact-conversation/orchestration.tsのrunNormalTurn()が
    // 行う配線と同じ形)。
    const turn2Tasks = decomposeTask({ input: turn2Input, previousUserInput: turn1Input });

    results.push(
      check(
        "[Scenario-Turn2] decomposeTask()にpreviousUserInput(Turn1)を渡すと、" +
          "Turn2もassignedCapability='research'になる(Phase86 Root Cause修正の直接検証)",
        turn2Tasks.length === 1 && turn2Tasks[0].assignedCapability === "research",
        `tasks=${JSON.stringify(turn2Tasks)}`
      )
    );

    results.push(
      check(
        "[Scenario-Turn2-NoContext] 今回のTurn2の文面は「追加で確認して」を含み、" +
          "単独判定パターン(Section4「明示的追加Research」)にも一致するため、" +
          "previousUserInputを渡さなくてもresearchになる(単独判定パターンの効果を確認する。" +
          "Context依存の必要性はContinuation系のテスト(もう少し増やして等)で別途検証済み)",
        (() => {
          const tasks = decomposeTask({ input: turn2Input });
          return tasks.length === 1 && tasks[0].assignedCapability === "research";
        })()
      )
    );

    // Turn3: previousUserInputにTurn2を渡しても、Turn3自体はTable/
    // Comparison要求でありResearch Capabilityを必要としない
    // (Phase81投資調査で確認済みの既存設計、Turn3はTable kind経由で
    // 既存Artifactのみから構築する)。ここではdecomposeTask()の
    // assignedCapabilityがTurn3では"research"にならないこと
    // (=既存Turn1/2のArtifact Blockを土台にkind="table"経路へ進む
        // 既存設計に影響しないこと)を確認する。
    const turn3Tasks = decomposeTask({ input: turn3Input, previousUserInput: turn2Input });

    results.push(
      check(
        "[Scenario-Turn3] Turn3はTable/Comparison要求でありResearch Capabilityを必要としない" +
          "(既存設計通り、assignedCapability!=='research'のままkind=table経路へ進む)",
        turn3Tasks.length === 1 && turn3Tasks[0].assignedCapability === undefined
      )
    );

  }

  return summarize("additional research intent routing (Phase 86)", results);

}
