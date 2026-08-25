// =========================
// TACT Table-aware Research / Structured Research Dataset Regression
// (Phase 90)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.tsのbuildResearchTableSchema()
// (新設)・classifyTablePurpose()(Section15拡張)・groundParsedEntities()
// (field単位Evidence保持)、core/tact-research/contextAssembly.tsの
// assembleResearchContext()(Table-aware Prompt注入)、
// core/tact-artifact/blocks.tsのbuildComparisonTableFromBlocks()
// (cellSourceEvidenceIds)、core/tact-orchestrator/decomposer.ts/
// executor.tsのTask.tableSchema配線。
//
// 環境制約(Phase66〜89と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。executor.ts経由のテストのみ、既存Harness pattern
// (registerCapability、Phase20〜83で確立済み)を用いる。

import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { createConcurrencyGovernor, resolveMaxAgents } from "../../../core/tact-orchestrator/concurrencyGovernor";
import { runTasks } from "../../../core/tact-orchestrator/executor";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import type { Task } from "../../../core/tact-orchestrator/task";
import type { ResearchParams, ResearchResult } from "../../../core/tact-research/types";
import { assembleResearchContext } from "../../../core/tact-research/contextAssembly";
import type { ResearchRequirement } from "../../../core/tact-research/knowledgeGap";
import {
  classifyTablePurpose,
  buildResearchTableSchema,
  groundParsedEntities,
  parseStructuredEntitiesFromText,
} from "../../../core/tact-conversation/artifactMutation";
import { buildComparisonTableFromBlocks, createExampleBlock } from "../../../core/tact-artifact/blocks";
import type { ArtifactBlock } from "../../../core/tact-artifact/types";
import type { ResearchEvidenceItem } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function emptyCoreContext() {
  return { knowledge: [], memories: [], examples: [], recentExecutions: [] };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test A: Comparison intent(classifyTablePurpose Section15拡張)
  // ==========================================================

  const comparisonIntentCases = [
    "比較表にしてください",
    "参加しやすさを比較できる表にしてください",
    "5件を比較してください",
    "参加費を比較できるように整理してください",
    "各サービスを比べられる表にしてください",
    "料金を比べてまとめてください",
  ];

  for (const input of comparisonIntentCases) {

    results.push(
      check(
        `[TestA] 「${input}」-> classifyTablePurpose()='comparison'`,
        classifyTablePurpose(input) === "comparison"
      )
    );

  }

  results.push(
    check(
      "[TestA-Evidence] Evidence Table意図(「根拠を表にして」)は引き続きevidenceのまま(回帰なし)",
      classifyTablePurpose("根拠を表にして") === "evidence" &&
        classifyTablePurpose("根拠となるEvidenceを表にしてください") === "evidence"
    )
  );

  // ==========================================================
  // Test B: Table Schema(Research前に列構成・要求件数を確定)
  // ==========================================================

  {
    const input =
      "愛知県内で大学生が参加しやすいイベントを5件調べて、イベント名、開催日、参加費、対象学年、開催形式、定員で比較表にして。";

    const schema = buildResearchTableSchema(input);

    results.push(
      check(
        "[TestB-1] ユーザー指定の6列がTable Schemaとして確定される",
        schema !== undefined &&
          JSON.stringify(schema.columns) ===
            JSON.stringify(["イベント名", "開催日", "参加費", "対象学年", "開催形式", "定員"]),
        `schema=${JSON.stringify(schema)}`
      )
    );

    results.push(
      check(
        "[TestB-2] 「5件」がrequestedRowCountとして確定される",
        schema?.requestedRowCount === 5
      )
    );

  }

  results.push(
    check(
      "[TestB-3] Table要求が無い通常のResearchはTable Schemaを持たない(既存挙動を壊さない)",
      buildResearchTableSchema("愛知県内の大学生向けスポーツイベントについて調査してください。") === undefined
    )
  );

  results.push(
    check(
      "[TestB-4] Evidence Table要求(「根拠を表にして」)はTable Schemaを持たない" +
        "(Entity/Attribute構造を前提としない用途のため対象外)",
      buildResearchTableSchema("根拠を表にしてください") === undefined
    )
  );

  results.push(
    check(
      "[TestB-5] 比較表要求でも列が明示されていない場合はTable Schemaを持たない" +
        "(列が不明な場合は既存のResearch後Row Entity化へフォールバック)",
      buildResearchTableSchema("比較表にしてください") === undefined
    )
  );

  // ==========================================================
  // Test: assembleResearchContext()のTable-aware Prompt注入
  // (決定論的な文字列組み立てのみ、実LLM呼び出しなし)
  // ==========================================================

  {
    const baseParams = {
      query: "愛知県のイベントについて",
      context: emptyCoreContext(),
      evidence: [],
      requirements: [] as ResearchRequirement[],
    };

    const withoutSchema = assembleResearchContext(baseParams);

    results.push(
      check(
        "[Prompt-1] tableSchema未指定時は既存Phase1〜89と完全に同じsystemPromptになる(後方互換)",
        !withoutSchema.systemPrompt.includes("比較表(Comparison Table)")
      )
    );

    const withSchema = assembleResearchContext({
      ...baseParams,
      tableSchema: { columns: ["イベント名", "開催日", "参加費"], requestedRowCount: 5 },
    });

    results.push(
      check(
        "[Prompt-2] tableSchema指定時、systemPromptに列構成・件数の指示が追加される",
        withSchema.systemPrompt.includes("比較表(Comparison Table)") &&
          withSchema.systemPrompt.includes("イベント名 / 開催日 / 参加費") &&
          withSchema.systemPrompt.includes("5件を目標")
      )
    );

    results.push(
      check(
        "[Prompt-3] userPromptにもTable Schemaのデータ(列名・件数)が明示される",
        withSchema.userPrompt.includes("Table Schema") &&
          withSchema.userPrompt.includes("イベント名, 開催日, 参加費") &&
          withSchema.userPrompt.includes("5")
      )
    );

    results.push(
      check(
        "[Prompt-4] JSON出力契約(answer/keyFindings/evidenceIds/uncertainty)の説明は" +
          "既存のまま変更されない(systemPromptに既存の出力形式セクションが残る)",
        withSchema.systemPrompt.includes('"evidenceIds"') &&
          withSchema.systemPrompt.includes('"uncertainty"')
      )
    );

  }

  // ==========================================================
  // Test C: Structured Entity(指定Columnに対応したfieldsが生成される)
  // ==========================================================

  {
    const answer = `
| イベント名 | 開催日 | 参加費 | 対象学年 | 開催形式 | 定員 |
|---|---|---|---|---|---|
| イベントA | 9/10 | 無料 | 大学3〜4年 | オンライン | 50名 |
| イベントB | 9/18 | 500円 | 大学生 | オフライン | 100名 |
`;

    const parsed = parseStructuredEntitiesFromText(answer);

    results.push(
      check(
        "[TestC] Table-aware Promptが想定する形式(Markdown Table)から、指定6列に対応したfieldsが" +
          "そのままEntity化される",
        parsed !== null &&
          parsed.length === 2 &&
          parsed[0].fields.some((f) => f.label === "開催日" && f.value === "9/10") &&
          parsed[0].fields.some((f) => f.label === "定員" && f.value === "50名"),
        `parsed=${JSON.stringify(parsed)}`
      )
    );

  }

  // ==========================================================
  // Test D: Field Evidence(Attribute単位のEvidence対応)
  // ==========================================================

  {
    const parsed = parseStructuredEntitiesFromText(`
| イベント名 | 開催日 | 参加費 |
|---|---|---|
| イベントA | 9/10 | 無料 |
`)!;

    const evidencePool: ResearchEvidenceItem[] = [
      { id: "ev-date", claim: "イベントA開催情報", source: "https://example.com/a", confidence: "high", snippet: "イベントAは9/10に開催される。" },
      { id: "ev-fee", claim: "イベントA参加費情報", source: "https://example.com/b", confidence: "high", snippet: "イベントAの参加費は無料。" },
    ];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestD-1] 開催日の値はev-date(のみ)が裏付ける",
        grounded.length === 1 &&
          JSON.stringify(grounded[0].entity.fields.find((f) => f.label === "開催日")?.sourceEvidenceIds) ===
            JSON.stringify(["ev-date"]),
        `grounded=${JSON.stringify(grounded)}`
      )
    );

    results.push(
      check(
        "[TestD-2] 参加費の値はev-fee(のみ)が裏付ける(開催日とは別のEvidence)",
        JSON.stringify(grounded[0].entity.fields.find((f) => f.label === "参加費")?.sourceEvidenceIds) ===
          JSON.stringify(["ev-fee"])
      )
    );

    // ---- buildComparisonTableFromBlocks()まで通してcellSourceEvidenceIdsを確認 ----
    const block = createExampleBlock(
      "summary",
      0,
      grounded[0].entity.title,
      grounded[0].entity.fields,
      grounded[0].sourceEvidenceIds
    );

    const table = buildComparisonTableFromBlocks([block], ["イベント名", "開催日", "参加費"], 0);

    results.push(
      check(
        "[TestD-3] TableBlock.cellSourceEvidenceIdsに、列ごとの個別Evidence対応が反映される" +
          "(rowSourceEvidenceIdsより細かい粒度)",
        table !== null &&
          table.cellSourceEvidenceIds !== undefined &&
          JSON.stringify(table.cellSourceEvidenceIds[0][1]) === JSON.stringify(["ev-date"]) &&
          JSON.stringify(table.cellSourceEvidenceIds[0][2]) === JSON.stringify(["ev-fee"]),
        `cellSourceEvidenceIds=${JSON.stringify(table?.cellSourceEvidenceIds)}`
      )
    );

    results.push(
      check(
        "[TestD-4] 既存のrowSourceEvidenceIds(行単位)は引き続き維持される(後方互換)",
        table !== null && JSON.stringify(table.rowSourceEvidenceIds?.[0]?.sort()) ===
          JSON.stringify(["ev-date", "ev-fee"].sort())
      )
    );

  }

  // ==========================================================
  // Test E: Missing Value(Evidenceが無い値は推測せず情報未確認)
  // ==========================================================

  {
    const parsed: { title: string; fields: { label: string; value: string }[] }[] = [
      { title: "イベントA", fields: [{ label: "開催日", value: "9/10" }, { label: "定員", value: "100名" }] },
    ];

    const evidencePool: ResearchEvidenceItem[] = [
      { id: "ev-1", claim: "イベントA情報", source: "https://example.com/a", confidence: "high", snippet: "イベントAは9/10に開催される。" },
    ];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestE] 定員(Evidenceに記載が無い)は推測されず「情報未確認」になり、sourceEvidenceIdsも持たない",
        grounded.length === 1 &&
          grounded[0].entity.fields.find((f) => f.label === "定員")?.value === "情報未確認" &&
          grounded[0].entity.fields.find((f) => f.label === "定員")?.sourceEvidenceIds === undefined,
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test F: Row数(検索結果件数ではなく完成Entity件数として扱う)
  // ==========================================================

  {
    // Evidenceで確認できたのは3件のTitleのみ(5件要求)。
    const parsed = [
      { title: "イベントA", fields: [{ label: "開催日", value: "9/10" }] },
      { title: "イベントB", fields: [{ label: "開催日", value: "9/18" }] },
      { title: "イベントC", fields: [{ label: "開催日", value: "9/20" }] },
    ];

    const evidencePool: ResearchEvidenceItem[] = [
      { id: "ev-1", claim: "一覧", source: "https://example.com", confidence: "medium", snippet: "イベントA、イベントB、イベントCが開催される。" },
    ];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestF] Evidenceで確認できたEntity数(3件)がそのままRow数になる" +
          "(検索結果ページ数ではなく、完成したEntity数)",
        grounded.length === 3
      )
    );

    results.push(
      check(
        "[TestF-NoFabrication] Evidenceに存在しないEntityが1つも含まれていないこと(捏造防止)",
        !grounded.some((g) => g.entity.title === "イベントD")
      )
    );

  }

  // ==========================================================
  // Test G: Backward Compatibility
  // ==========================================================

  {
    // tableSchema省略時、既存のExampleBlock.fields(sourceEvidenceIdsを
    // 持たない)からもTableが正しく構築できること(既存Artifact JSON
    // との互換性)。
    const legacyBlocks: ArtifactBlock[] = [
      createExampleBlock("イベント名: イベントA", 0, "イベントA", [{ label: "イベント名", value: "イベントA" }], ["ev-legacy"]),
    ];

    const table = buildComparisonTableFromBlocks(legacyBlocks, ["イベント名"], 0);

    results.push(
      check(
        "[TestG] field単位sourceEvidenceIdsを持たない既存Artifact由来のExampleBlockからも、" +
          "Table自体は正しく構築される(cellSourceEvidenceIdsはundefinedのまま、rowSourceEvidenceIdsで" +
          "後方互換を維持)",
        table !== null &&
          table.rows[0][0] === "イベントA" &&
          table.cellSourceEvidenceIds === undefined &&
          JSON.stringify(table.rowSourceEvidenceIds?.[0]) === JSON.stringify(["ev-legacy"]),
        `table=${JSON.stringify(table)}`
      )
    );

  }

  // ==========================================================
  // Test: decomposeTask() -> Task.tableSchema配線
  // ==========================================================

  {
    const tasks = decomposeTask({
      input: "愛知県内で大学生向けイベントについて調査してください。",
      tableSchema: { columns: ["イベント名", "開催日"], requestedRowCount: 5 },
    });

    results.push(
      check(
        "[Wiring-1] decomposeTask()がOrchestrationRequest.tableSchemaをResearch Taskへ引き継ぐ",
        tasks.length === 1 &&
          tasks[0].assignedCapability === "research" &&
          JSON.stringify(tasks[0].tableSchema) ===
            JSON.stringify({ columns: ["イベント名", "開催日"], requestedRowCount: 5 })
      )
    );

  }

  {
    // capabilityがresearchにならない入力(chat)には、tableSchemaが
    // 指定されていても引き継がれない(Research以外のTaskには無意味)。
    const tasks = decomposeTask({
      input: "ありがとう",
      tableSchema: { columns: ["イベント名"], requestedRowCount: 5 },
    });

    results.push(
      check(
        "[Wiring-2] assignedCapability!=='research'の場合、tableSchemaは引き継がれない",
        tasks.length === 1 && tasks[0].assignedCapability === undefined && tasks[0].tableSchema === undefined
      )
    );

  }

  // ==========================================================
  // Test: executor.ts -> ResearchOptions.tableSchema配線
  // (registerCapability経由、既存Phase20〜83のHarness pattern)
  // ==========================================================

  {
    let capturedOptions: ResearchParams["options"] | undefined;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      capturedOptions = params.options;
      return {
        success: true,
        answer: "mock answer",
        evidence: [],
        metadata: {
          executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
          searchQueryCount: 0, searchRequestCount: 0, searchAttempts: [],
          retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
          usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
          usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
          durationMs: 1, mocked: true, requirementCount: 0, coveredRequirementCount: 0,
          partialRequirementCount: 0, missingRequirementCount: 0, gapQueries: [], safetyDowngradeCount: 0,
        },
      };
    });

    const task: Task = {
      id: crypto.randomUUID(),
      description: "テスト",
      status: "pending",
      assignedCapability: "research",
      tableSchema: { columns: ["イベント名", "開催日"], requestedRowCount: 3 },
    };

    const core = createMockCoreCapability();
    const governor = createConcurrencyGovernor(resolveMaxAgents());

    await runTasks([task], core, {}, governor);

    results.push(
      check(
        "[Wiring-3] executor.ts経由でTask.tableSchemaがResearchParams.options.tableSchemaへ橋渡しされる" +
          "(実Capability呼び出しはmock、新しいLLM呼び出しは発生しない)",
        JSON.stringify(capturedOptions?.tableSchema) ===
          JSON.stringify({ columns: ["イベント名", "開催日"], requestedRowCount: 3 }),
        `capturedOptions=${JSON.stringify(capturedOptions)}`
      )
    );

  }

  return summarize("table-aware research / structured research dataset (Phase 90)", results);

}
