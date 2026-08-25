// =========================
// TACT Evidence-Grounded Artifact Regression (Phase 78 Tier1)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsの
// needsSupplementalResearchForArtifact()・buildSupplementalResearchQuery()・
// runSupplementalResearchForArtifact()・mergeSupplementalEvidence()
// (Table/Chart用の追加Research、Section2〜3)、core/tact-artifact/blocks.tsの
// sourceEvidenceIds Traceability(Section5)。
//
// 環境制約(Phase66〜77と同一): 実DB書き込み・実LLM API・実Search APIは
// 一切呼ばない。runSupplementalResearchForArtifact()のテストのみ、
// 既存Harness pattern(mock capability registration、Phase20〜28・33・
// 67〜69・77で一貫して使用)を用いる。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import type { ResearchParams, ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import {
  needsSupplementalResearchForArtifact,
  buildSupplementalResearchQuery,
  runSupplementalResearchForArtifact,
  mergeSupplementalEvidence,
} from "../../../core/tact-conversation/orchestration";
import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import {
  buildTableFromBlocks,
  appendRowsToTable,
  buildChartFromTable,
  createEvidenceBlock,
  createExampleBlock,
} from "../../../core/tact-artifact/blocks";
import type { ArtifactBlock, TableBlock } from "../../../core/tact-artifact/types";
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

  // ==========================================================
  // needsSupplementalResearchForArtifact(): 決定論的判定
  // ==========================================================

  results.push(
    check(
      "[NeedsA1] table + 既存Example/Evidenceが0件 -> true(追加Research要)",
      needsSupplementalResearchForArtifact("table", [])
    )
  );

  {
    const withExample: ArtifactBlock[] = [createExampleBlock("事例A", 0, "事例A")];
    results.push(
      check(
        "[NeedsA2] table + 既存Exampleがある -> false(既存データで足りる、追加コストを発生させない)",
        !needsSupplementalResearchForArtifact("table", withExample)
      )
    );
  }

  {
    const withTable: ArtifactBlock[] = [
      { id: "t1", type: "table", columns: ["a"], rows: [["1"]], order: 0, createdAt: "x", updatedAt: "x" },
    ];
    results.push(
      check(
        "[NeedsA3] table + 既存Tableがある -> false(追記はappendRowsToTableの既存経路に委ねる)",
        !needsSupplementalResearchForArtifact("table", withTable)
      )
    );
  }

  results.push(
    check(
      "[NeedsA4] chart + 既存Tableが無い -> true",
      needsSupplementalResearchForArtifact("chart", [])
    )
  );

  {
    const withTable: ArtifactBlock[] = [
      { id: "t1", type: "table", columns: ["a"], rows: [["1"]], order: 0, createdAt: "x", updatedAt: "x" },
    ];
    results.push(
      check(
        "[NeedsA5] chart + 既存Tableがある -> false(Tier1では数値抽出をしないため、追加Researchでは解消しない)",
        !needsSupplementalResearchForArtifact("chart", withTable)
      )
    );
  }

  results.push(
    check(
      "[NeedsA6] research/evidence/generic等 -> false(対象外)",
      !needsSupplementalResearchForArtifact("research", []) &&
        !needsSupplementalResearchForArtifact("evidence", []) &&
        !needsSupplementalResearchForArtifact("generic", [])
    )
  );

  // ==========================================================
  // buildSupplementalResearchQuery(): RESEARCH_PATTERNへ確実に一致
  // ==========================================================

  {
    const query = buildSupplementalResearchQuery("それぞれのメガスポーツイベントの来場者数と競技数を表にして");
    const decision = classifyIntent(query);

    results.push(
      check(
        "[QueryB1] 補足ResearchクエリはclassifyIntent()でintent='research'に確実に分類される",
        decision.intent === "research",
        `query=${JSON.stringify(query)}, decision=${JSON.stringify(decision)}`
      )
    );
  }

  results.push(
    check(
      "[QueryB2] クエリは命令文(「表にして」)を含まない(deriveArtifactTitle経由)",
      !buildSupplementalResearchQuery("来場者数を表にして").includes("表にして")
    )
  );

  // ==========================================================
  // runSupplementalResearchForArtifact(): mock capability経由
  // ==========================================================

  {
    let receivedQuery: string | undefined;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      receivedQuery = params.query;
      return {
        success: true,
        answer: "来場者数は約120万人でした。",
        evidence: [
          { id: "e1", claim: "2023年の来場者数は120万人だった", source: "https://example.com/report", confidence: "high" },
        ],
        metadata: makeMetadata(),
      };
    });

    const outcome = await runSupplementalResearchForArtifact(undefined, "来場者数を表にして");

    results.push(
      check(
        "[RunC1] mock research capabilityから取得したEvidenceがそのまま返る",
        outcome.evidence.length === 1 &&
          outcome.evidence[0].claim === "2023年の来場者数は120万人だった" &&
          outcome.answer === "来場者数は約120万人でした。"
      )
    );

    results.push(
      check(
        "[RunC2] Orchestratorへ渡ったqueryは命令文を含まない補足クエリ(元のuserInputそのままではない)",
        receivedQuery !== undefined &&
          receivedQuery !== "来場者数を表にして" &&
          !receivedQuery.includes("表にして"),
        `receivedQuery=${JSON.stringify(receivedQuery)}`
      )
    );

  }

  {
    // Repository Evidence(このテスト実装時に判明): capability自体が
    // 例外を投げても、core/tact-orchestrator/executor.tsのexecuteTask()
    // が既にtry/catchで吸収し、TaskExecutionSummary.status="failed"
    // (例外を外へ再送出しない)として返す設計になっている。そのため
    // runOrchestration()自体は例外を投げず、失敗説明文を含む
    // answerとevidence=[]を返す——runSupplementalResearchForArtifact()
    // 側のtry/catch(Phase78実装)は、それとは別に「runOrchestration()
    // 自体が想定外に例外を投げた場合」への二重の安全網として存在する。
    // ここでは前者(evidence=[]になり、Table/Chart側が安全にinsufficient_data
    // 判定できること、Test N「Research失敗時にArtifactを壊さない」の
    // 本質)を検証する。
    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      throw new Error("simulated research failure");
    });

    const outcome = await runSupplementalResearchForArtifact(undefined, "来場者数を表にして");

    results.push(
      check(
        "[RunD1] capabilityが例外を投げても、runSupplementalResearchForArtifact()は例外を外へ投げずevidence=[]を返す(Test N)",
        Array.isArray(outcome.evidence) && outcome.evidence.length === 0
      )
    );

  }

  // ==========================================================
  // mergeSupplementalEvidence(): 既存Blockを壊さずEvidenceを追記
  // ==========================================================

  {
    const existing: ArtifactBlock[] = [createExampleBlock("既存事例", 0, "既存事例")];

    const merged = mergeSupplementalEvidence(existing, [
      { id: "e1", claim: "新しい根拠", source: "https://example.com", confidence: "medium" },
    ]);

    results.push(
      check(
        "[MergeE1] 既存Blockが消えず、新しいEvidence Blockが1件追記される",
        merged.length === 2 &&
          merged[0].type === "example" &&
          merged[1].type === "evidence" &&
          (merged[1] as { claim: string }).claim === "新しい根拠"
      )
    );

  }

  results.push(
    check(
      "[MergeE2] evidence=[]の場合、existingBlocksをそのまま返す(no-op)",
      mergeSupplementalEvidence([], []).length === 0
    )
  );

  // ==========================================================
  // Evidence Traceability(Section5): sourceEvidenceIds
  // ==========================================================

  {
    const evidenceBlocks: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
      createEvidenceBlock({ claim: "主張2", source: "src2", confidence: "medium" }, 1),
    ];

    const table = buildTableFromBlocks(evidenceBlocks, 2, "比較表");

    results.push(
      check(
        "[TraceF1] Evidence由来のTableはsourceEvidenceIdsに元Evidence Blockのidを保持する",
        table !== null &&
          table.sourceEvidenceIds !== undefined &&
          table.sourceEvidenceIds.length === 2 &&
          table.sourceEvidenceIds.includes((evidenceBlocks[0] as { id: string }).id) &&
          table.sourceEvidenceIds.includes((evidenceBlocks[1] as { id: string }).id),
        `table=${JSON.stringify(table)}`
      )
    );

  }

  {
    const exampleBlocks: ArtifactBlock[] = [createExampleBlock("事例A", 0, "事例A")];
    const table = buildTableFromBlocks(exampleBlocks, 1);

    results.push(
      check(
        "[TraceF2] Example由来のTableはsourceEvidenceIdsを持たない(Evidence Blockを経由しないため捏造しない)",
        table !== null && table.sourceEvidenceIds === undefined
      )
    );

  }

  {
    const initialEvidence: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
    ];
    const table = buildTableFromBlocks(initialEvidence, 1) as TableBlock;

    const moreEvidence: ArtifactBlock[] = [
      ...initialEvidence,
      createEvidenceBlock({ claim: "主張2", source: "src2", confidence: "medium" }, 2),
    ];

    const updated = appendRowsToTable(table, moreEvidence);

    results.push(
      check(
        "[TraceF3] appendRowsToTable()は追記した行の根拠もsourceEvidenceIdsへ追加する",
        updated.sourceEvidenceIds !== undefined && updated.sourceEvidenceIds.length === 2,
        `sourceEvidenceIds=${JSON.stringify(updated.sourceEvidenceIds)}`
      )
    );

  }

  {
    const numericTable: TableBlock = {
      id: "t1",
      type: "table",
      columns: ["イベント名", "参加者数"],
      rows: [["イベントA", "120"]],
      sourceEvidenceIds: ["e1", "e2"],
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    const chart = buildChartFromTable(numericTable, 1);

    results.push(
      check(
        "[TraceF4] Chartは元Tableのsource EvidenceIdsをそのまま引き継ぐ",
        chart !== null &&
          chart.sourceEvidenceIds !== undefined &&
          chart.sourceEvidenceIds.length === 2 &&
          chart.sourceEvidenceIds.includes("e1")
      )
    );

  }

  // ==========================================================
  // 捏造防止(Test H): Tableの値はEvidence本文の複製のみで、
  // Evidenceに無い値が現れない
  // ==========================================================

  {
    const evidenceBlocks: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "2023年の来場者数は120万人だった", source: "https://example.com", confidence: "high" }, 0),
    ];

    const table = buildTableFromBlocks(evidenceBlocks, 1);

    const evidenceBlock = evidenceBlocks[0] as { claim: string; source?: string; confidence?: string };

    results.push(
      check(
        "[NoFabricationG1] Table生成はEvidence.claim/source/confidenceの複製のみで、新しい数値・文言を生成しない",
        table !== null &&
          table.rows[0][0] === evidenceBlock.claim &&
          table.rows[0][1] === evidenceBlock.source &&
          table.rows[0][2] === evidenceBlock.confidence,
        `row=${JSON.stringify(table?.rows[0])}`
      )
    );

  }

  return summarize("tact-artifact evidence-grounded artifact (Phase 78 Tier1)", results);

}
