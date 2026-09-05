// =========================
// TACT Artifact Block Architecture Regression (Phase 76)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.ts(classifyArtifactMutation/
// buildResearchMutationBlocks/buildSimpleMutationBlock)、
// core/tact-artifact/blocks.ts(legacyContentToBlocks/
// renderBlocksToPlainText/buildTableFromBlocks/appendRowsToTable/
// buildChartFromTable)、core/tact-artifact/store.ts(toArtifact()の
// Legacy Adapter分岐)。いずれも純粋関数のみ(DB/LLM/Search API呼び出し
// なし、Phase75と同じ既存方針)。

import {
  classifyArtifactMutation,
  detectArtifactMutationIntent,
  buildResearchMutationBlocks,
  buildSimpleMutationBlock,
} from "../../../core/tact-conversation/artifactMutation";
import {
  legacyContentToBlocks,
  renderBlocksToPlainText,
  buildTableFromBlocks,
  appendRowsToTable,
  buildChartFromTable,
  createExampleBlock,
  createEvidenceBlock,
} from "../../../core/tact-artifact/blocks";
import { toArtifact, type ArtifactRow } from "../../../core/tact-artifact/store";
import type { ArtifactBlock, TableBlock } from "../../../core/tact-artifact/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- classifyArtifactMutation(): 種類の分類 ----

  results.push(
    check(
      "[Classify1] capability='research' -> 'research'",
      classifyArtifactMutation("中京大学のスポーツ系ゼミについて調査して", "orchestrator") === "research" ||
        classifyArtifactMutation("何でもいい", "research") === "research"
    )
  );

  results.push(
    check(
      "[Classify2] 「この比較をグラフにして」+ orchestrator -> 'chart'",
      classifyArtifactMutation("この比較をグラフにして", "orchestrator") === "chart"
    )
  );

  results.push(
    check(
      "[Classify3] 「大学ごとに表にまとめて」+ orchestrator -> 'table'",
      classifyArtifactMutation("大学ごとに表にまとめて", "orchestrator") === "table"
    )
  );

  results.push(
    check(
      "[Classify4] 「重要な主張に根拠を追加して」+ orchestrator -> 'evidence'",
      classifyArtifactMutation("重要な主張に根拠を追加して", "orchestrator") === "evidence"
    )
  );

  results.push(
    check(
      "[Classify5] 「他大学の事例も追加して」+ orchestrator -> 'example'",
      classifyArtifactMutation("他大学の事例も追加して", "orchestrator") === "example"
    )
  );

  results.push(
    check(
      "[Classify6] 「ここまでの調査をもとに施策を追加して」+ orchestrator -> 'recommendation'",
      classifyArtifactMutation("ここまでの調査をもとに施策を追加して", "orchestrator") === "recommendation"
    )
  );

  results.push(
    check(
      "[Classify7] 「仮説を追加して」+ orchestrator -> 'hypothesis'",
      classifyArtifactMutation("仮説を追加して", "orchestrator") === "hypothesis"
    )
  );

  results.push(
    check(
      "[Classify8] 「これを成果物に追加して」(特定語彙に一致しない明示指示) -> 'generic'",
      classifyArtifactMutation("これを成果物に追加して", "orchestrator") === "generic"
    )
  );

  results.push(
    check(
      "[Classify9] 「こんにちは」-> null(Artifact更新しない)",
      classifyArtifactMutation("こんにちは", "orchestrator") === null
    )
  );

  // ---- classifyArtifactMutation()とdetectArtifactMutationIntent()の一貫性 ----
  //
  // Phase75の既存回帰テストを壊さないための絶対条件: classify(...) !== null は
  // 常にdetectArtifactMutationIntent(...)と同じ真偽値を返す。

  const consistencyInputs: [string, "research" | "orchestrator" | "chat" | "core_push"][] = [
    ["こんにちは", "orchestrator"],
    ["この調査って結局何が重要？", "orchestrator"],
    ["結論を教えて", "orchestrator"],
    ["中京大学のスポーツ系ゼミについて調査して", "research"],
    ["他大学の事例も追加して", "orchestrator"],
    ["この比較をグラフにして", "orchestrator"],
    ["大学ごとに表にまとめて", "orchestrator"],
    ["これを成果物に追加して", "orchestrator"],
    ["重要な主張に根拠を追加して", "orchestrator"],
    ["ここまでの調査をもとに施策を追加して", "orchestrator"],
    ["仮説を追加して", "orchestrator"],
  ];

  const allConsistent = consistencyInputs.every(
    ([input, capability]) =>
      (classifyArtifactMutation(input, capability) !== null) ===
      detectArtifactMutationIntent(input, capability)
  );

  results.push(
    check(
      "[Consistency] classifyArtifactMutation()!==null は detectArtifactMutationIntent() と常に一致する",
      allConsistent
    )
  );

  // ---- legacyContentToBlocks(): Section13 Backward Compatibility ----

  results.push(
    check(
      "[Legacy1] 空文字 -> 空配列(空のArtifactを無理にBlock化しない)",
      legacyContentToBlocks("").length === 0
    )
  );

  {
    const blocks = legacyContentToBlocks("## 概要\n\n本文");
    results.push(
      check(
        "[Legacy2] 非空文字 -> TextBlock 1件、contentがそのまま入る",
        blocks.length === 1 && blocks[0].type === "text" && (blocks[0] as { content: string }).content === "## 概要\n\n本文"
      )
    );
  }

  // ---- toArtifact(): Legacy Adapter分岐 ----

  {
    const legacyRow: ArtifactRow = {
      id: "art-legacy",
      user_id: "user-1",
      project_id: null,
      work_id: null,
      title: "Legacy Artifact",
      content: "旧形式の本文",
      blocks: null,
      version: 2,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
    };

    const artifact = toArtifact(legacyRow);

    results.push(
      check(
        "[Adapter1] blocks=null(Legacy行) -> toArtifact()がcontentをTextBlockへ変換する",
        artifact.blocks.length === 1 && artifact.blocks[0].type === "text"
      )
    );
  }

  {
    const structuredRow: ArtifactRow = {
      id: "art-structured",
      user_id: "user-1",
      project_id: null,
      work_id: null,
      title: "Structured Artifact",
      content: "",
      blocks: [
        {
          id: "b1",
          type: "finding",
          content: "重要な発見",
          order: 0,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      ],
      version: 2,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
    };

    const artifact = toArtifact(structuredRow);

    results.push(
      check(
        "[Adapter2] blocksが非空 -> row.blocksをそのまま使う(Legacy変換を経由しない)",
        artifact.blocks.length === 1 && artifact.blocks[0].type === "finding"
      )
    );
  }

  // ---- buildResearchMutationBlocks(): Section9 ----

  {
    const blocks = buildResearchMutationBlocks(
      "中京大学のスポーツ系ゼミについて調査して",
      "調査結果本文",
      ["発見1", "発見2"],
      [{ id: "e1", claim: "主張1", source: "https://example.com", confidence: "high", snippet: "根拠の抜粋" }],
      []
    );

    results.push(
      check(
        "[Research1] ResearchSummary + Finding×2 + Evidence×1 の計4Blockが生成される",
        blocks.length === 4 &&
          blocks[0].type === "research_summary" &&
          blocks[1].type === "finding" &&
          blocks[2].type === "finding" &&
          blocks[3].type === "evidence",
        `types=${blocks.map((b) => b.type).join(",")}`
      )
    );

    const evidenceBlock = blocks[3] as { claim: string; source?: string; confidence?: string; data?: string };

    results.push(
      check(
        "[Research2] Evidence Blockがclaim/source/confidence/dataを正しく保持する",
        evidenceBlock.claim === "主張1" &&
          evidenceBlock.source === "https://example.com" &&
          evidenceBlock.confidence === "high" &&
          evidenceBlock.data === "根拠の抜粋"
      )
    );
  }

  {
    const existing: ArtifactBlock[] = [
      { id: "old-1", type: "text", content: "既存の内容", order: 0, createdAt: "x", updatedAt: "x" },
    ];

    const blocks = buildResearchMutationBlocks("追加調査して", "本文", [], [], existing);

    results.push(
      check(
        "[Research3] 既存Blockを渡した場合、既存Blockが消えずに先頭へ残る(絶対条件Section12)",
        blocks.length === 3 && blocks[0].id === "old-1",
        `types=${blocks.map((b) => b.type).join(",")}`
      )
    );

    // Phase77修正: keyFindings=[]でもanswerが非空ならFinding Blockが
    // 1件生成される(コメントと実装の乖離バグを修正、Repository
    // Evidence: Reality TestでSearch失敗時にFinding不在のArtifactが
    // 生成される実害を確認した)。
    results.push(
      check(
        "[Research3-b] keyFindings=[]でもanswerからFinding Blockが1件生成される(Phase77修正)",
        blocks.some((b) => b.type === "finding" && (b as { content: string }).content === "本文")
      )
    );
  }

  // ---- buildSimpleMutationBlock(): example/evidence/recommendation/hypothesis ----

  {
    const blocks = buildSimpleMutationBlock("example", "事例を追加して", "事例の本文", []);
    results.push(
      check(
        "[Simple1] kind='example' -> ExampleBlockが1件追加される",
        blocks.length === 1 && blocks[0].type === "example"
      )
    );
  }

  {
    const blocks = buildSimpleMutationBlock("recommendation", "施策を追加して", "提案の本文", []);
    results.push(
      check(
        "[Simple2] kind='recommendation' -> RecommendationBlockが1件追加される",
        blocks.length === 1 && blocks[0].type === "recommendation"
      )
    );
  }

  {
    const blocks = buildSimpleMutationBlock("hypothesis", "仮説を追加して", "仮説の本文", []);
    results.push(
      check(
        "[Simple3] kind='hypothesis' -> HypothesisBlockが1件追加される",
        blocks.length === 1 && blocks[0].type === "hypothesis"
      )
    );
  }

  // ---- buildTableFromBlocks(): Section7「事例を表にまとめて」 ----

  {
    const exampleBlocks: ArtifactBlock[] = [
      createExampleBlock("事例Aの説明", 0, "事例A"),
      createExampleBlock("事例Bの説明", 1, "事例B"),
    ];

    const table = buildTableFromBlocks(exampleBlocks, 2, "比較表");

    results.push(
      check(
        "[Table1] Example Blockが存在する -> TableBlockがExample由来で構築される",
        table !== null && table.rows.length === 2 && table.columns.length === 2,
        `table=${JSON.stringify(table)}`
      )
    );
  }

  {
    const evidenceBlocks: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
    ];

    const table = buildTableFromBlocks(evidenceBlocks, 1);

    results.push(
      check(
        "[Table2] Example Blockが無くEvidence Blockのみ -> Evidence由来で構築される",
        table !== null && table.rows.length === 1 && table.rows[0][0] === "主張1"
      )
    );
  }

  results.push(
    check(
      "[Table3] Example/Evidenceどちらも無い -> null(偽Tableを作らない)",
      buildTableFromBlocks([], 0) === null
    )
  );

  // ---- appendRowsToTable(): Section7「この表にさらに2件追加して」 ----

  {
    const initialExamples: ArtifactBlock[] = [createExampleBlock("事例Aの説明", 0, "事例A")];
    const table = buildTableFromBlocks(initialExamples, 1) as TableBlock;

    const withMoreExamples: ArtifactBlock[] = [
      ...initialExamples,
      createExampleBlock("事例Bの説明", 2, "事例B"),
      createExampleBlock("事例Cの説明", 3, "事例C"),
    ];

    const updated = appendRowsToTable(table, withMoreExamples);

    results.push(
      check(
        "[TableAppend1] 新しいExample 2件を追加 -> Tableの行が1件から3件に増える(既存行は保持)",
        updated.rows.length === 3 && updated.rows[0][0] === "事例A",
        `rows=${JSON.stringify(updated.rows)}`
      )
    );
  }

  {
    const initialExamples: ArtifactBlock[] = [createExampleBlock("事例Aの説明", 0, "事例A")];
    const table = buildTableFromBlocks(initialExamples, 1) as TableBlock;

    const updated = appendRowsToTable(table, initialExamples);

    results.push(
      check(
        "[TableAppend2] 追加すべき新規Exampleが無い -> 既存Tableをそのまま返す(no-op)",
        updated.rows.length === 1
      )
    );
  }

  // ---- buildChartFromTable(): Section10 ----

  {
    const table: TableBlock = {
      id: "t1",
      type: "table",
      columns: ["イベント名", "参加者数"],
      rows: [
        ["イベントA", "120"],
        ["イベントB", "80"],
      ],
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    const chart = buildChartFromTable(table, 1, "参加者数の比較");

    results.push(
      check(
        "[Chart1] 数値列を持つTable -> ChartBlockが構築される",
        chart !== null &&
          chart.chartType === "bar" &&
          chart.data.length === 2 &&
          chart.data[0].value === 120,
        `chart=${JSON.stringify(chart)}`
      )
    );
  }

  {
    const table: TableBlock = {
      id: "t2",
      type: "table",
      columns: ["事例", "詳細"],
      rows: [["事例A", "説明文であり数値ではない"]],
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    results.push(
      check(
        "[Chart2] 数値化できる列が無い -> null(偽Chartを作らない)",
        buildChartFromTable(table, 1) === null
      )
    );
  }

  // ---- renderBlocksToPlainText(): Artifact.content互換フィールド ----

  {
    const blocks: ArtifactBlock[] = [
      { id: "b1", type: "finding", title: "発見", content: "重要な発見", order: 1, createdAt: "x", updatedAt: "x" },
      { id: "b2", type: "text", content: "本文", order: 0, createdAt: "x", updatedAt: "x" },
    ];

    const text = renderBlocksToPlainText(blocks);

    results.push(
      check(
        "[Render1] order昇順で結合され、両方のBlockの内容を含む",
        text.indexOf("本文") < text.indexOf("重要な発見") &&
          text.includes("本文") &&
          text.includes("重要な発見")
      )
    );
  }

  return summarize("tact-artifact block architecture (Phase 76)", results);

}
