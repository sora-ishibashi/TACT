// =========================
// memoryCandidateBuilder / Core-only安全性 Regression (Phase 36)
// =========================
//
// 対象: core/tact-orchestrator/memoryCandidateBuilder.ts の
// buildMemoryCandidates()(Research由来Knowledge candidateのcontent
// 形式、Phase36修正)。
//
// Phase34/35のReality Testで実測した不具合(Research自動生成Knowledgeの
// content内部形式"Q:/A:"が、coreOnlyAnswer.tsのCore-only Answerability
// (STEP180、無加工でcontentをそのまま返す設計)を経由してユーザーへ
// 露出する)の回帰防止。coreOnlyAnswer.ts自体は変更していないため、
// Test Bでは実際の(未変更の)buildCoreOnlyAnswer()を直接importして
// 使い、「入力されるKnowledgeのcontentが正しければ安全に通る」ことを
// 検証する(Core-only側を書き換えてテストを通しているのではないことを
// 明確にするため)。
//
// Category A/B(Deterministic Evaluation)。LLM/API呼び出み0件。

import { buildMemoryCandidates } from "../../../core/tact-orchestrator/memoryCandidateBuilder";
import { buildCoreOnlyAnswer } from "../../../core/tact-research/coreOnlyAnswer";
import type { Task, TaskExecutionSummary } from "../../../core/tact-orchestrator/task";
import type { OrchestrationRequest } from "../../../core/tact-orchestrator/types";
import type { KnowledgeItem } from "../../../core/tact-core/knowledge/types";
import { check, summarize, type CheckResult } from "../lib/check";

const QUESTION = "中京大学について簡単に調べて";
const ANSWER = "中京大学は愛知県名古屋市に本部を置く私立大学です。";

function makeResearchTask(): Task {
  return {
    id: "t1",
    description: QUESTION,
    status: "pending",
    assignedCapability: "research",
  };
}

function makeResearchSummary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskId: "t1",
    status: "completed",
    capability: "research",
    output: ANSWER,
    researchExecutionMode: "web-research",
    evidenceCount: 1,
    ...overrides,
  };
}

const request: OrchestrationRequest = {
  userId: "phase36-test-user",
  input: QUESTION,
};

function makeKnowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "k1",
    scope: "user",
    ownerId: "phase36-test-user",
    source: "orchestrator:research:task=t1",
    tags: [],
    createdAt: new Date().toISOString(),
    kind: "reference",
    title: QUESTION,
    content: ANSWER,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test A: Research CandidateのcontentがQ:/A:形式を含まず、
  // 回答本文のみになっていること。質問文はdescriptionへ分離される ----
  {
    const task = makeResearchTask();
    const summary = makeResearchSummary();

    const candidates = buildMemoryCandidates(task, summary, request);
    const researchCandidate = candidates.find((c) => c.memoryType === "knowledge_memory");

    results.push(
      check(
        "[TestA] Research Candidate.content === 回答本文のみ(Q:/A:形式を含まない)",
        researchCandidate?.content === ANSWER,
        `content=${JSON.stringify(researchCandidate?.content)}`
      )
    );

    results.push(
      check(
        "[TestA] contentに\"Q:\"/\"A:\"という内部書式が一切含まれない",
        !researchCandidate?.content.includes("Q:") && !researchCandidate?.content.includes("A:"),
        `content=${JSON.stringify(researchCandidate?.content)}`
      )
    );

    results.push(
      check(
        "[TestA] 質問文はdescriptionへ分離されて保持される",
        researchCandidate?.description === QUESTION,
        `description=${JSON.stringify(researchCandidate?.description)}`
      )
    );
  }

  // ---- Test B: Phase36修正後のcontent形式のKnowledgeItemを、
  // 実際の(未変更の)buildCoreOnlyAnswer()へ渡しても、最終answerに
  // "Q:"/"A:"が混入しないこと(Core-only側は無変更のまま検証) ----
  {
    const knowledgeItem = makeKnowledgeItem({ content: ANSWER, title: QUESTION });

    const coreOnlyResult = buildCoreOnlyAnswer({ knowledge: [knowledgeItem], memories: [] });

    results.push(
      check(
        "[TestB] Phase36形式のKnowledgeをCore-onlyへ渡してもanswerに内部書式が混入しない",
        coreOnlyResult.answer === ANSWER &&
          !coreOnlyResult.answer.includes("Q:") &&
          !coreOnlyResult.answer.includes("A:"),
        `answer=${JSON.stringify(coreOnlyResult.answer)}`
      )
    );
  }

  // ---- Test C: 既存の手動Knowledge(自然文content、Phase36以前から
  // 存在する形)が、従来どおりCore-onlyで正しく回答できること
  // (既存挙動を壊していないことの確認) ----
  {
    const manualKnowledge = makeKnowledgeItem({
      id: "k2",
      source: "manual_push",
      title: "中京大学の所在地",
      content: "中京大学は愛知県名古屋市にキャンパスを構えています。",
    });

    const coreOnlyResult = buildCoreOnlyAnswer({ knowledge: [manualKnowledge], memories: [] });

    results.push(
      check(
        "[TestC] 手動Knowledge(自然文content)は従来どおりそのままCore-only回答になる",
        coreOnlyResult.answer === manualKnowledge.content,
        `answer=${JSON.stringify(coreOnlyResult.answer)}`
      )
    );
  }

  // ---- 回帰: Research以外(explicit intent等)のCandidateはdescription
  // フィールドを持たず、既存のcontent-based titleの挙動に影響しない
  // ことを確認(TestA以外の既存経路が壊れていないこと) ----
  {
    const task: Task = { id: "t2", description: "今後はできるだけ簡潔に答えて", status: "pending" };
    const summary: TaskExecutionSummary = { taskId: "t2", status: "completed", output: "了解しました" };
    const candidates = buildMemoryCandidates(task, summary, request);

    results.push(
      check(
        "[回帰] Preference Candidateはdescriptionフィールドを持たない(Research専用の変更のため)",
        candidates.length > 0 && candidates[0].description === undefined,
        `candidates=${JSON.stringify(candidates)}`
      )
    );
  }

  return summarize("memoryCandidateBuilder / Core-only safety", results);

}
