// =========================
// TACT Volatile Research Knowledge除外 Regression (Phase 94)
// =========================
//
// 対象: core/tact-research/answerability.ts(isVolatileResearchKnowledge()・
// assessAnswerability())、core/tact-research/knowledgeGap.ts
// (classifyRequirement()経由のcanAnswerAllFromCoreOnly())、
// core/tact-orchestrator/memoryWriter.ts(writeMemoryCandidates()の
// recordKnowledge()呼び出しへのmetadata.freshness伝播)。
//
// Root Cause(Phase91〜93投資調査、Repository Evidence: 3回の独立した
// 実Reality Testで再現): あるConversationのWeb Research結果が
// "knowledge_memory"としてscope:"user"のKnowledgeへ永続化された後、
// 全く別のConversationの後続Turnがそれを拾い、Core-only Answerability
// (LLM 0回・Search 0回)へ短絡してしまい、claim=古いUser Input・
// source=古いtask IDがそのままEvidenceとして混入していた。
//
// 環境制約: 実DB書き込み・実LLM API・実Search APIは一切呼ばない。
// mockCoreCapability(core/tact-core/mockCoreCapability.ts、プロセス内
// メモリのみ)を使い、DB接続を伴わずにwriteMemoryCandidates()→
// loadContext()の往復を検証する(Category B、Mock-based Evaluation)。

import "dotenv/config";
import {
  isVolatileResearchKnowledge,
  assessAnswerability,
} from "../../../core/tact-research/answerability";
import { detectKnowledgeGap, canAnswerAllFromCoreOnly } from "../../../core/tact-research/knowledgeGap";
import { buildMemoryCandidates } from "../../../core/tact-orchestrator/memoryCandidateBuilder";
import { writeMemoryCandidates } from "../../../core/tact-orchestrator/memoryWriter";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import type { Task, TaskExecutionSummary } from "../../../core/tact-orchestrator/task";
import type { OrchestrationRequest } from "../../../core/tact-orchestrator/types";
import type { KnowledgeItem } from "../../../core/tact-core/knowledge/types";
import type { CoreContext } from "../../../core/tact-core";
import { check, summarize, type CheckResult } from "../lib/check";

const USER_ID = "phase94-test-user";

function makeKnowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "k1",
    scope: "user",
    ownerId: USER_ID,
    source: "upload",
    tags: [],
    createdAt: new Date().toISOString(),
    kind: "reference",
    title: "テスト知識",
    content: "テスト内容",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyContext(overrides: Partial<CoreContext> = {}): CoreContext {
  return {
    knowledge: [],
    memories: [],
    examples: [],
    recentExecutions: [],
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test1: isVolatileResearchKnowledge() 単体
  // ==========================================================

  results.push(
    check(
      "[Test1-1] source=\"orchestrator:research:task=...\"はvolatile判定される" +
        "(Phase91〜93の実混入データと同じsource形式)",
      isVolatileResearchKnowledge(makeKnowledgeItem({ source: "orchestrator:research:task=ee1967bd-8e95" }))
    )
  );

  results.push(
    check(
      "[Test1-2] metadata.freshness=\"volatile\"のみでもvolatile判定される" +
        "(sourceがorchestrator:research:以外でも将来の保険として機能する)",
      isVolatileResearchKnowledge(makeKnowledgeItem({ source: "some-other-origin", metadata: { freshness: "volatile" } }))
    )
  );

  results.push(
    check(
      "[Test1-3] 手動Knowledge(source=\"upload\"、metadataなし)はvolatile判定されない" +
        "(過剰な無効化をしない)",
      !isVolatileResearchKnowledge(makeKnowledgeItem({ source: "upload" }))
    )
  );

  results.push(
    check(
      "[Test1-4] 明示的Memory Intent由来(source=\"orchestrator:explicit_intent:task=...\")は" +
        "volatile判定されない(Research由来のみを対象とする)",
      !isVolatileResearchKnowledge(makeKnowledgeItem({ source: "orchestrator:explicit_intent:task=t1" }))
    )
  );

  // ==========================================================
  // Test2: assessAnswerability() — volatileなKnowledgeはCore-only
  // Answerabilityの根拠にならない
  // ==========================================================

  {
    // SIMPLE_FACT_PATTERNSに一致する単純事実質問(「Xとは？」)を使い、
    // 時間依存語を含まない状態でKnowledge一致だけを検証する。
    const query = "TACT Research Datasetとは？";

    const volatileOnlyContext = emptyContext({
      knowledge: [
        makeKnowledgeItem({
          id: "k-volatile",
          source: "orchestrator:research:task=old-task",
          title: query,
          content: "TACT Research Datasetは古いResearch結果に由来する情報です。",
        }),
      ],
    });

    const result = assessAnswerability(query, volatileOnlyContext);

    results.push(
      check(
        "[Test2-1] volatileなResearch由来Knowledgeしか無い場合、Core-only Answerabilityは" +
          "falseになる(Web Research経路へ進む、Phase91〜93の混入バグの直接的な修正確認)",
        result.canAnswerFromCoreOnly === false,
        `result=${JSON.stringify(result.reason)}`
      )
    );

  }

  {
    // 回帰確認: durable(Research由来ではない)Knowledgeは、従来通り
    // Core-only Answerabilityの根拠として機能する(過剰な無効化をして
    // いないことの確認)。
    const query = "TACT本体とは？";

    const durableContext = emptyContext({
      knowledge: [
        makeKnowledgeItem({
          id: "k-durable",
          source: "upload",
          title: query,
          content: "TACT本体はマルチAgent Research/分析システムです。",
        }),
      ],
    });

    const result = assessAnswerability(query, durableContext);

    results.push(
      check(
        "[Test2-2] durableなKnowledge(手動登録等)は従来通りCore-only Answerabilityの" +
          "根拠として機能する(回帰なし)",
        result.canAnswerFromCoreOnly === true,
        `result=${JSON.stringify(result.reason)}`
      )
    );

  }

  // ==========================================================
  // Test3: knowledgeGap.ts — volatileなKnowledgeはRequirementを
  // "covered"にできない
  // ==========================================================

  {
    // Turn2実文面と同じ構造(時間依存語を含まない、複数文でも6ルールの
    // いずれにも一致しないため単一Requirementへフォールバックする)。
    const query =
      "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベント さっき調べた内容に、" +
      "大学3〜4年生が実際に参加しやすそうなものをさらに5件ほど追加で確認してください。";

    const volatileOnlyContext = emptyContext({
      knowledge: [
        makeKnowledgeItem({
          id: "k-volatile",
          source: "orchestrator:research:task=ee1967bd-8e95-4ecf-b6c5-d5e044c6c01f",
          title: "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベントについて調査してください。",
          content: "愛知県内で2026年8月から10月に開催される大学生向けのインターンシップ・キャリアイベント",
        }),
      ],
    });

    const requirements = detectKnowledgeGap(query, volatileOnlyContext);

    results.push(
      check(
        "[Test3-1] volatileなResearch由来Knowledgeしか無い場合、Requirementは" +
          "\"covered\"にならない(Turn2/Turn3で観測された誤ったCore-only短絡の直接的な修正確認)",
        requirements.every((r) => r.status !== "covered"),
        `requirements=${JSON.stringify(requirements.map((r) => ({ status: r.status, score: r.relevanceScore })))}`
      )
    );

    results.push(
      check(
        "[Test3-2] 上記の結果、canAnswerAllFromCoreOnly()もfalseになり、実Web Research" +
          "(Discovery→Deepening)へ進む",
        canAnswerAllFromCoreOnly(query, requirements) === false
      )
    );

  }

  // ==========================================================
  // Test4: writeMemoryCandidates() — Research由来Candidateの
  // freshness("volatile")がmetadata経由でKnowledgeItemへ実際に
  // 永続化されること(mockCoreCapability往復)
  // ==========================================================

  {
    const core = createMockCoreCapability();

    const task: Task = {
      id: "t-research-1",
      description: "愛知県内の大学生向けインターンシップイベントについて調査してください。",
      status: "pending",
      assignedCapability: "research",
    };

    const summary: TaskExecutionSummary = {
      taskId: task.id,
      status: "completed",
      capability: "research",
      output: "愛知県内のインターンシップ情報はポータルサイトで確認できます。",
      researchExecutionMode: "web-research",
      evidenceCount: 1,
    };

    const request: OrchestrationRequest = { userId: USER_ID, input: task.description };

    const candidates = buildMemoryCandidates(task, summary, request);
    const researchCandidate = candidates.find((c) => c.memoryType === "knowledge_memory");

    results.push(
      check(
        "[Test4-1] buildMemoryCandidates()がResearch由来candidateをfreshness=\"volatile\"で生成する" +
          "(既存Phase5の挙動、回帰確認)",
        researchCandidate?.freshness === "volatile"
      )
    );

    const outcomes = await writeMemoryCandidates(candidates, core);
    const writtenOutcome = outcomes.find((o) => o.candidate.memoryType === "knowledge_memory");

    results.push(
      check(
        "[Test4-2] writeMemoryCandidates()がResearch由来candidateの書き込みに成功する",
        writtenOutcome?.status === "written",
        `outcome=${JSON.stringify(writtenOutcome)}`
      )
    );

    const context = await core.loadContext({ userId: USER_ID });
    const persistedItem = context.knowledge.find((k) => k.id === writtenOutcome?.itemId);

    results.push(
      check(
        "[Test4-3] 永続化されたKnowledgeItem.metadata.freshnessが\"volatile\"として読み戻せる" +
          "(Phase94修正前は一切metadataへ渡っていなかった)",
        persistedItem?.metadata?.freshness === "volatile",
        `persistedItem=${JSON.stringify(persistedItem)}`
      )
    );

    results.push(
      check(
        "[Test4-4] 永続化されたKnowledgeItemはisVolatileResearchKnowledge()でtrueと判定される" +
          "(実際の書き込み→判定の往復確認)",
        !!persistedItem && isVolatileResearchKnowledge(persistedItem)
      )
    );

  }

  // ==========================================================
  // Test5: End-to-end simulation — Phase91〜93で実際に観測された
  // 「別Conversationのstale Knowledgeによる誤ったCore-only短絡」を
  // mockCoreCapabilityで再現し、修正後は発生しないことを確認する
  // ==========================================================

  {
    const core = createMockCoreCapability();

    // Step1: 過去のConversation(Phase91相当)でResearch Taskが完了し、
    // knowledge_memoryとして永続化される。
    const oldTask: Task = {
      id: "old-conversation-task",
      description:
        "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベントについて調査してください。" +
        "2026年8月〜10月に開催されるものを中心に、大学生が実際に参加しやすそうなイベントを探してください。",
      status: "pending",
      assignedCapability: "research",
    };

    const oldSummary: TaskExecutionSummary = {
      taskId: oldTask.id,
      status: "completed",
      capability: "research",
      output: "愛知県内のインターンシップ・キャリアイベントについての情報はポータルサイトで確認できます。",
      researchExecutionMode: "web-research",
      evidenceCount: 1,
    };

    const oldRequest: OrchestrationRequest = { userId: USER_ID, input: oldTask.description };

    const oldCandidates = buildMemoryCandidates(oldTask, oldSummary, oldRequest);
    await writeMemoryCandidates(oldCandidates, core);

    // Step2: 全く別の新しいConversationのTurn2相当(前Turnの主題を
    // 引き継いだ追加調査要求)が、同じuserIdでCore Contextをロードする。
    const newTurnQuery =
      "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベント さっき調べた内容に、" +
      "大学3〜4年生が実際に参加しやすそうなものをさらに5件ほど追加で確認してください。";

    const context = await core.loadContext({ userId: USER_ID });

    results.push(
      check(
        "[Test5-1] 別Conversationの新しいTurnが、過去のConversationで永続化された" +
          "Research由来Knowledgeをcontext.knowledgeとして受け取る" +
          "(Knowledgeがscope:\"user\"でConversation非依存であること自体は仕様通り)",
        context.knowledge.some((k) => k.source.startsWith("orchestrator:research:"))
      )
    );

    const requirements = detectKnowledgeGap(newTurnQuery, context);

    results.push(
      check(
        "[Test5-2] 修正後、この新しいTurnはstaleなKnowledgeを根拠に\"covered\"と判定されない" +
          "(Phase91〜93で実際に観測された誤短絡が、mockCoreCapability上でも再現しないことを確認)",
        requirements.every((r) => r.status !== "covered"),
        `requirements=${JSON.stringify(requirements.map((r) => r.status))}`
      )
    );

    results.push(
      check(
        "[Test5-3] canAnswerAllFromCoreOnly()もfalseになり、実際のDiscovery→Deepening" +
          "(Web Research)経路へ進む",
        canAnswerAllFromCoreOnly(newTurnQuery, requirements) === false
      )
    );

  }

  return summarize("volatile-research-knowledge-exclusion (Phase 94)", results);

}
