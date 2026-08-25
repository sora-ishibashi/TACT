// =========================
// TACT Research Evidence Integrity Regression (Phase 83)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.tsのgroundParsedEntities()
// (新設、Evidence Grounding)・appendRowEntitiesFromText()(evidencePool
// 引数追加)、core/tact-conversation/orchestration.tsのgrounding配線
// (buildResearchOutcomeWithOptionalTable()・mergeSupplementalRowEntities())、
// core/tact-research/queryGeneration.ts・requirementDecomposition.ts
// (Research Queryの条件保持)。
//
// 環境制約(Phase66〜82と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。groundParsedEntities()・appendRowEntitiesFromText()・
// buildResearchQueries()はいずれも純粋関数(LLM/API呼び出しなし)。

import "dotenv/config";
import {
  groundParsedEntities,
  appendRowEntitiesFromText,
} from "../../../core/tact-conversation/artifactMutation";
import {
  buildResearchOutcomeWithOptionalTable,
  buildBlocksForMutationKind,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import { buildResearchQueries } from "../../../core/tact-research/queryGeneration";
import { decomposeIntoRequirements } from "../../../core/tact-research/requirementDecomposition";
import { buildComparisonTableFromBlocks, createEvidenceBlock } from "../../../core/tact-artifact/blocks";
import type { ArtifactBlock, TableBlock } from "../../../core/tact-artifact/types";
import type { ParsedStructuredEntity } from "../../../core/tact-conversation/artifactMutation";
import type { ResearchEvidenceItem } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function normalPlan(
  overrides: Partial<Extract<ConversationOrchestrationPlan, { kind: "normal" }>> = {}
): Extract<ConversationOrchestrationPlan, { kind: "normal" }> {

  return {
    kind: "normal",
    executionId: "exec-1",
    status: "completed",
    answer: "デフォルト回答",
    capability: "research",
    evidence: [],
    keyFindings: [],
    ...overrides,
  };

}

function ev(
  id: string,
  claim: string,
  snippet?: string
): ResearchEvidenceItem {
  return { id, claim, source: `https://example.com/${id}`, confidence: "medium", snippet };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test A: Evidenceに存在するイベント名 -> Entity化される
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      { title: "名古屋マラソン", fields: [{ label: "競技", value: "マラソン" }] },
    ];

    const evidencePool = [ev("e1", "愛知県のイベント一覧", "名古屋マラソンは名古屋市で開催されるマラソン大会。")];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestA] Evidenceに存在するイベント名はEntity化される",
        grounded.length === 1 && grounded[0].entity.title === "名古屋マラソン",
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test B: Evidenceに存在しないイベント名 -> Entity化されない
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      { title: "架空の大会2026", fields: [{ label: "競技", value: "マラソン" }] },
    ];

    const evidencePool = [ev("e1", "愛知県のイベント一覧", "名古屋マラソンは名古屋市で開催されるマラソン大会。")];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestB] Evidenceに存在しないイベント名はEntity化されない(架空の固有名詞を採用しない)",
        grounded.length === 0,
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test C: Evidenceに地域がない -> 地域を推測しない
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      { title: "名古屋マラソン", fields: [{ label: "地域", value: "名古屋市" }] },
    ];

    // titleは裏付けられるが、"名古屋市"という地域情報はEvidence本文に
    // 一切登場しない(Evidenceはイベントの存在だけを確認している)。
    const evidencePool = [ev("e1", "愛知県のイベント一覧", "名古屋マラソンというマラソン大会が開催される。")];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestC] Evidenceに地域の記載が無い場合、地域を推測せず「情報未確認」にする",
        grounded.length === 1 && grounded[0].entity.fields[0].value === "情報未確認",
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test D: Evidenceに対象者がない -> 対象者を推測しない
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      { title: "名古屋マラソン", fields: [{ label: "対象者", value: "大学生" }] },
    ];

    const evidencePool = [ev("e1", "愛知県のイベント一覧", "名古屋マラソンというマラソン大会が開催される。")];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestD] Evidenceに対象者の記載が無い場合、対象者を推測せず「情報未確認」にする",
        grounded.length === 1 && grounded[0].entity.fields[0].value === "情報未確認",
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test E: Evidenceに「参加しやすい理由」がない -> 推測しない
  // (Reality Testで問題となった、LLMが最も推測しやすい属性)
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      {
        title: "名古屋マラソン",
        fields: [{ label: "参加しやすい理由", value: "初心者向けで友達と参加しやすい" }],
      },
    ];

    const evidencePool = [ev("e1", "愛知県のイベント一覧", "名古屋マラソンというマラソン大会が開催される。")];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestE] Evidenceに根拠が無い「参加しやすい理由」は一般論として採用せず「情報未確認」にする",
        grounded.length === 1 && grounded[0].entity.fields[0].value === "情報未確認",
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test F・G・H: 件数制御(5件要求に対し、確認できた件数だけ採用する)
  // ==========================================================

  function makeFiveClaimedEntities(): ParsedStructuredEntity[] {
    return ["名古屋マラソン", "豊田マラソン", "岡崎シティマラソン", "一宮七夕マラソン", "犬山ハーフマラソン"].map(
      (title) => ({ title, fields: [{ label: "地域", value: "愛知県" }] })
    );
  }

  {
    // Test F: 5件要求・Evidenceで5件とも確認できる -> 5件
    const evidencePool = [
      ev("e1", "愛知県のイベント一覧", "名古屋マラソン、豊田マラソン、岡崎シティマラソン、一宮七夕マラソン、犬山ハーフマラソンが愛知県内で開催される。"),
    ];

    const grounded = groundParsedEntities(makeFiveClaimedEntities(), evidencePool);

    results.push(
      check(
        "[TestF] 5件要求・5件ともEvidenceで確認できる場合 -> 5件採用される",
        grounded.length === 5,
        `count=${grounded.length}`
      )
    );

  }

  {
    // Test G: 5件要求・Evidenceで4件しか確認できない -> 4件(5件目を捏造しない)
    const evidencePool = [
      ev("e1", "愛知県のイベント一覧", "名古屋マラソン、豊田マラソン、岡崎シティマラソン、一宮七夕マラソンが愛知県内で開催される。"),
    ];

    const grounded = groundParsedEntities(makeFiveClaimedEntities(), evidencePool);

    results.push(
      check(
        "[TestG] 5件要求・Evidenceで4件しか確認できない場合 -> 4件のみ採用(5件目を捏造しない)",
        grounded.length === 4 && !grounded.some((g) => g.entity.title === "犬山ハーフマラソン"),
        `titles=${JSON.stringify(grounded.map((g) => g.entity.title))}`
      )
    );

  }

  {
    // Test H: 5件要求・Evidenceで1件も確認できない -> 0件
    const evidencePool = [ev("e1", "無関係な話題", "この記事はスポーツイベントとは関係のない内容です。")];

    const grounded = groundParsedEntities(makeFiveClaimedEntities(), evidencePool);

    results.push(
      check(
        "[TestH] 5件要求・Evidenceで1件も確認できない場合 -> 0件(架空の5件を作らない)",
        grounded.length === 0,
        `count=${grounded.length}`
      )
    );

  }

  // ==========================================================
  // Test I: 各EntityにsourceEvidenceIdsが存在する
  // ==========================================================

  {
    const parsed: ParsedStructuredEntity[] = [
      { title: "名古屋マラソン", fields: [] },
      { title: "豊田マラソン", fields: [] },
    ];

    const evidencePool = [
      ev("e1", "名古屋マラソン特集", "名古屋マラソンは大規模なマラソン大会。"),
      ev("e2", "豊田マラソン特集", "豊田マラソンは地域密着型のマラソン大会。"),
    ];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[TestI] 各EntityにそのEntityを実際に裏付けたsourceEvidenceIdsが個別に付与される(Turn全体のIDを一律付与しない)",
        grounded.length === 2 &&
          JSON.stringify(grounded.find((g) => g.entity.title === "名古屋マラソン")?.sourceEvidenceIds) ===
            JSON.stringify(["e1"]) &&
          JSON.stringify(grounded.find((g) => g.entity.title === "豊田マラソン")?.sourceEvidenceIds) ===
            JSON.stringify(["e2"]),
        `grounded=${JSON.stringify(grounded)}`
      )
    );

  }

  // ==========================================================
  // Test J: Comparison Tableの各RowにrowSourceEvidenceIdsが存在する
  // (groundParsedEntities()の出力がExampleBlock.sourceEvidenceIds経由で
  // Comparison TableのrowSourceEvidenceIdsまで正しく伝播することを、
  // 実際のパイプライン(appendRowEntitiesFromText->buildComparisonTableFromBlocks)
  // で確認する)
  // ==========================================================

  {
    const answer = `
| イベント名 | 地域 |
|---|---|
| 名古屋マラソン | 名古屋市 |
| 豊田マラソン | 豊田市 |
`;

    const evidencePool = [
      ev("e1", "名古屋マラソン特集", "名古屋マラソンは名古屋市で開催される。"),
      ev("e2", "豊田マラソン特集", "豊田マラソンは豊田市で開催される。"),
    ];

    const blocks = appendRowEntitiesFromText([], answer, [], evidencePool);

    const table = buildComparisonTableFromBlocks(blocks, ["イベント名", "地域"], 0);

    results.push(
      check(
        "[TestJ] Comparison Tableの各RowにEvidenceへ遡れるrowSourceEvidenceIdsが存在し、Rowごとに別々のEvidenceを正しく指す",
        table !== null &&
          table.rowSourceEvidenceIds !== undefined &&
          JSON.stringify(table.rowSourceEvidenceIds[0]) === JSON.stringify(["e1"]) &&
          JSON.stringify(table.rowSourceEvidenceIds[1]) === JSON.stringify(["e2"]),
        `rowSourceEvidenceIds=${JSON.stringify(table?.rowSourceEvidenceIds)}`
      )
    );

  }

  // ==========================================================
  // Test K: Research Queryにユーザー指定条件が保持される
  // ==========================================================

  {
    const query = "愛知県の大学生が参加できる就活イベントを5件";

    // どのQuery Categoryにも一致しない(会社/市場/競合のいずれでもない)
    // ため、buildResearchQueries()はqueryそのものを唯一の検索語として
    // 使う(Section8の懸念「条件が失われる」は、決定論的Decomposition
        // ルールがどれにも一致しない場合、query全体を1つのRequirementとして
    // 安全側フォールバックする設計により発生しないことを確認する)。
    const queries = buildResearchQueries(query);
    const requirements = decomposeIntoRequirements(query);

    results.push(
      check(
        "[TestK-1] 該当カテゴリが無いqueryは、地域・対象者・件数等の条件を含んだ元のqueryがそのまま検索語になる",
        queries.includes(query) &&
          queries.every((q) => q.includes("愛知県") && q.includes("大学生") && q.includes("5件")),
        `queries=${JSON.stringify(queries)}`
      )
    );

    results.push(
      check(
        "[TestK-2] 明確な分解パターンに一致しない場合、Requirementへの分解でも条件を落とさず単一Requirementへ安全側フォールバックする",
        requirements.length === 1 &&
          requirements[0].includes("愛知県") &&
          requirements[0].includes("大学生") &&
          requirements[0].includes("就活イベント") &&
          requirements[0].includes("5件"),
        `requirements=${JSON.stringify(requirements)}`
      )
    );

  }

  // ==========================================================
  // Test L: 既存Evidence Tableが壊れない
  // ==========================================================

  {
    const evidenceBlocks: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
      createEvidenceBlock({ claim: "主張2", source: "src2", confidence: "medium" }, 1),
    ];

    const outcome = buildBlocksForMutationKind("table", "根拠を表にして", normalPlan(), evidenceBlocks);
    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestL] Evidence Groundingの導入後も、既存Evidence Table(「根拠を表にして」)は無変更で動作する",
        outcome.blocks !== null &&
          outcome.detail.tablePurpose === "evidence" &&
          table !== undefined &&
          JSON.stringify(table.columns) === JSON.stringify(["主張", "出典", "確信度"]) &&
          table.rows.length === 2,
        `detail=${JSON.stringify(outcome.detail)}`
      )
    );

  }

  // ==========================================================
  // Test M: 既存Comparison Tableが壊れない(Evidenceが十分な場合は
  // 従来通りComparison Tableが成立する)
  // ==========================================================

  {
    const userInput =
      "愛知県の大学生が参加しやすいスポーツイベントについて調査して。イベントを2件、イベント名・地域で比較表にして。";

    const plan = normalPlan({
      answer: `
| イベント名 | 地域 |
|---|---|
| 名古屋マラソン | 名古屋市 |
| 豊田マラソン | 豊田市 |
`,
      keyFindings: [],
      evidence: [
        ev(
          "e1",
          "愛知県のイベント一覧",
          "名古屋マラソンは名古屋市で開催される。豊田マラソンは豊田市で開催される。"
        ),
      ],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);
    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table" && b.tablePurpose === "comparison");

    results.push(
      check(
        "[TestM] Evidenceが十分な場合、従来通りComparison Tableが正しく生成される(回帰なし)",
        outcome.blocks !== null &&
          table !== undefined &&
          table.rows.length === 2 &&
          table.rows.some((r) => r[0] === "名古屋マラソン"),
        `table=${JSON.stringify(table)}`
      )
    );

  }

  // ==========================================================
  // Test N: 既存Researchのみの挙動が変わらない
  // ==========================================================

  {
    const plan = normalPlan({
      answer: "愛知県の大学生のスポーツ参加傾向について、一般的な知見を整理しました。",
      keyFindings: ["参加率は緩やかに増加傾向"],
      evidence: [ev("e1", "スポーツ庁調査", "大学生のスポーツ参加率に関する統計データ。")],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "愛知県の大学生のスポーツ参加について調査して",
      plan,
      []
    );

    results.push(
      check(
        "[TestN] Table/Chart要求の無いResearch単体の挙動は、Evidence Grounding導入後も変化しない",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "research_summary") &&
          outcome.blocks.some((b) => b.type === "finding") &&
          outcome.blocks.some((b) => b.type === "evidence") &&
          !outcome.blocks.some((b) => b.type === "table") &&
          outcome.detail.tableStatus === undefined
      )
    );

  }

  return summarize("tact-research-evidence-integrity (Phase 83)", results);

}
