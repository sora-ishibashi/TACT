// =========================
// buildTaskContext Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/taskContext.ts の buildTaskContext()。
// core/tact-core/mockCoreCapability.ts(STEP175、プロセス内メモリのみ、
// DB接続なし)を使い、Category B(Mock-based Evaluation)として
// Phase4/8/9のMemory-aware Context Sharding・Retrieval汚染修正の
// Reality Testを恒久化する。実LLM/API呼び出み0件。

import { buildTaskContext } from "../../../core/tact-orchestrator/taskContext";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import type { Task, TaskExecutionSummary } from "../../../core/tact-orchestrator/task";
import type { CoreCapability } from "../../../core/tact-core/types";
import { check, summarize, type CheckResult } from "../lib/check";

const USER_ID = "phase20-taskcontext-user";

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: "t1", description: "テスト", status: "pending", ...overrides };
}

async function seedKnowledge(
  core: CoreCapability,
  title: string,
  content: string
) {
  await core.recordKnowledge({
    scope: "user",
    ownerId: USER_ID,
    source: "test",
    tags: [],
    kind: "document",
    title,
    content,
  });
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Phase9: chat task(assignedCapability未指定)でもCore retrieval
  // が行われること(Phase4〜8時点はskipしていたが、Phase9で撤廃)。
  // mockCoreCapabilityのscoreQueryRelevance()は空白区切りtoken単位の
  // 一致(STEP177)のため、日本語のみの文はbuildRetrievalQuery()でも
  // 1トークンのまま残り(意図的な既存仕様、形態素解析は追加しない)、
  // 文全体の完全一致を要求してしまう。ASCII/CJK混在の語(既存の
  // Phase8/9 Reality Testでも使われた形)を使い、「retrievalが実際に
  // 実行され、関連Knowledgeを拾えること」を確認する。
  {
    const core = createMockCoreCapability();
    await seedKnowledge(core, "TACT Phase9の概要", "TACTのPhase9機能についての説明資料");

    const task = makeTask({ description: "TACT Phase9について教えて" }); // assignedCapability無し=chat
    const ctx = await buildTaskContext(task, core, { userId: USER_ID }, []);

    results.push(
      check(
        "[Phase9] chat Task(assignedCapability未指定)でもCore retrievalが実行される",
        ctx.coreContext.knowledge.length === 1,
        `knowledge件数=${ctx.coreContext.knowledge.length}`
      )
    );
  }

  // ---- Phase8 不具合#1回帰確認: 数字+ピリオドの断片化汚染
  // ("5.7" -> "5"/"."/"7") ----
  {
    const core = createMockCoreCapability();
    // 無関係な知識(たまたま数字の"7"を含む)
    await seedKnowledge(core, "7月の会議メモ", "この文書は7月に作成されたプロジェクト進捗メモです。");
    // 関連する知識(実際に一致すべき)
    await seedKnowledge(core, "TypeScript 5.7", "TypeScriptのバージョン5.7で追加された新機能一覧。");

    const task = makeTask({ description: "TypeScript 5.7の新機能について教えて" });
    const ctx = await buildTaskContext(task, core, { userId: USER_ID }, []);

    const titles = ctx.coreContext.knowledge.map((k) => k.title);

    results.push(
      check(
        "[Phase8-bug1] 数字断片化(\"5.7\"->\"5\"/\".\"/\"7\")による無関係Knowledge混入が起きない",
        titles.includes("TypeScript 5.7") && !titles.includes("7月の会議メモ"),
        `matched=${JSON.stringify(titles)}`
      )
    );
  }

  // ---- Phase8 不具合#2回帰確認: 英字1文字トークン汚染
  // ("A社" -> 独立した"A"トークン) ----
  {
    const core = createMockCoreCapability();
    // 無関係な知識(たまたま英字"a"を含む、ほぼ全ての英数字混じり文章に該当)
    await seedKnowledge(core, "quarterly report draft", "This is an internal draft memo about scheduling.");
    await seedKnowledge(core, "A社のサービス", "A社が提供するクラウドサービスの概要。");

    const task = makeTask({ description: "A社とB社のサービスをそれぞれ調べて比較して" });
    const ctx = await buildTaskContext(task, core, { userId: USER_ID }, []);

    const titles = ctx.coreContext.knowledge.map((k) => k.title);

    results.push(
      check(
        "[Phase8-bug2] 英字1文字トークン(\"A\"単独)による無関係Knowledge混入が起きない",
        !titles.includes("quarterly report draft"),
        `matched=${JSON.stringify(titles)}`
      )
    );
  }

  // ---- Phase9 不具合#3回帰確認: 日本語助詞の孤立トークン化汚染
  // ("PHASE9_TEST_ALPHAとPHASE9_TEST_BETA" -> 独立した"と"トークン) ----
  {
    const core = createMockCoreCapability();
    // 無関係な知識(「と」を自然に含む、ほぼ全ての日本語文に該当)
    await seedKnowledge(core, "無関係な議事録", "会議では予算とスケジュールについて話し合いました。");

    const task = makeTask({
      description: "PHASE20_TEST_ALPHAとPHASE20_TEST_BETAという2つの案について教えて",
    });
    const ctx = await buildTaskContext(task, core, { userId: USER_ID }, []);

    const titles = ctx.coreContext.knowledge.map((k) => k.title);

    results.push(
      check(
        "[Phase9-bug3] 助詞孤立トークン(\"と\"単独)による無関係Knowledge混入が起きない",
        !titles.includes("無関係な議事録"),
        `matched=${JSON.stringify(titles)}`
      )
    );
  }

  // ---- Phase4: dependencyResultsはcompletedなTaskのoutputのみを含む ----
  {
    const core = createMockCoreCapability();
    const task = makeTask({ id: "t2", description: "後続処理" });

    const dependencySummaries: TaskExecutionSummary[] = [
      { taskId: "t1", status: "completed", output: "前段の結果" },
      { taskId: "t0", status: "failed", output: undefined, error: "失敗した依存" },
    ];

    const ctx = await buildTaskContext(task, core, { userId: USER_ID }, dependencySummaries);

    results.push(
      check(
        "[Phase4] dependencyResultsはcompletedなTaskのoutputのみを含む",
        ctx.dependencyResults.length === 1 && ctx.dependencyResults[0].output === "前段の結果",
        JSON.stringify(ctx.dependencyResults)
      )
    );
  }

  // ---- 未認証(userId未指定) -> 空のCoreContext、Core呼び出み無し ----
  {
    const core = createMockCoreCapability();
    const task = makeTask({ description: "何か調べて" });
    const ctx = await buildTaskContext(task, core, {}, []);

    results.push(
      check(
        "[Phase4] userId未指定 -> 空のCoreContext(安全側フォールバック)",
        ctx.coreContext.knowledge.length === 0 &&
          ctx.coreContext.memories.length === 0 &&
          ctx.coreContext.examples.length === 0
      )
    );
  }

  return summarize("buildTaskContext", results);

}
