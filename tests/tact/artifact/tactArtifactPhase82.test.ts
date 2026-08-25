// =========================
// TACT 複数ターンComparison Table接続 Regression (Phase 82)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのbuildTableOutcomeForUserInput()
// (Comparison Tableの不正フォールバック禁止、Phase82-A)・
// buildResearchOutcomeWithOptionalTable()(Row Entity抽出の常時実行、
// Phase82-D)、core/tact-conversation/artifactMutation.tsの
// parseNumberedFieldList()(ネストしたfield行の誤認識修正、Phase82-B)。
//
// classifyIntent()(Phase82-C、具体例/実例/事例+依頼表現)のテストは
// tests/tact/intent/classifyIntent.test.tsのPhase82-J/Kケースを参照
// (このファイルでは重複させない)。
//
// 環境制約(Phase66〜81と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。Test L(Supplemental Research)のみ、既存Harness
// pattern(mock capability registration、userIdは必ずundefined)を
// 用いる。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import type { ResearchParams, ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import {
  buildBlocksForMutationKind,
  buildResearchOutcomeWithOptionalTable,
  needsSupplementalResearchForArtifact,
  runSupplementalResearchForArtifact,
  mergeSupplementalRowEntities,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import {
  parseStructuredEntitiesFromText,
  parseComparisonColumns,
  classifyTablePurpose,
  parseRequestedRowCount,
} from "../../../core/tact-conversation/artifactMutation";
import {
  buildComparisonTableFromBlocks,
  createExampleBlock,
  createEvidenceBlock,
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

function structuredEvent(
  order: number,
  title: string,
  fields: { label: string; value: string }[],
  sourceEvidenceIds?: string[]
): ArtifactBlock {
  return createExampleBlock(
    fields.map((f) => `${f.label}: ${f.value}`).join(" / "),
    order,
    title,
    fields,
    sourceEvidenceIds
  );
}

const NESTED_BOLD_ANSWER = `
愛知県内や東海地方で大学生が参加しているスポーツイベントの具体例を5件紹介しますね。

1. **名古屋マラソン**
   - **対象者**: 一般（学生を含む）
   - **競技**: マラソン
   - **特徴**: 名古屋市内を巡る大規模大会
   - **参加しやすい理由**: エントリー枠が広い
2. **名古屋オープンテニス**
   - **対象者**: 大学生中心
   - **競技**: テニス
   - **特徴**: 大学対抗戦形式
   - **参加しやすい理由**: 参加費が安い
3. **愛知県学生サッカー大会**
   - **対象者**: 大学生
   - **競技**: サッカー
   - **特徴**: 県内大学が多数参加
   - **参加しやすい理由**: チーム単位で参加できる
`;

// Phase83(Evidence Grounding): NESTED_BOLD_ANSWERの3件それぞれの
// title・fields値をすべて実際に含むEvidence本文(実際のSearch Result
// snippetにこの内容が書かれていたことを模す)。groundParsedEntities()は
// Evidence本文に存在しない固有名詞・属性値を採用しないため、このテスト
// 用answerの内容がEvidence側にも存在する状態を用意する。
const NESTED_BOLD_EVIDENCE_SNIPPET =
  "名古屋マラソンは対象者が一般（学生を含む）で競技はマラソン。" +
  "特徴は名古屋市内を巡る大規模大会で、参加しやすい理由はエントリー枠が広いこと。" +
  "名古屋オープンテニスは対象者が大学生中心で競技はテニス。" +
  "特徴は大学対抗戦形式で、参加しやすい理由は参加費が安いこと。" +
  "愛知県学生サッカー大会は対象者が大学生で競技はサッカー。" +
  "特徴は県内大学が多数参加で、参加しやすい理由はチーム単位で参加できること。";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test A: Comparison TableでRow Entity 0件 -> Evidence Tableへ
  // フォールバックしない
  // ==========================================================

  {
    const existingBlocks: ArtifactBlock[] = [
      createExampleBlock("事例Aの非構造化な説明文", 0, "事例A"),
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 1),
    ];

    const outcome = buildBlocksForMutationKind("table", "比較表にして", normalPlan(), existingBlocks);

    results.push(
      check(
        "[TestA] Row Entity 0件のcomparisonリクエストはEvidence Tableへフォールバックせず拒否する",
        outcome.blocks === null &&
          outcome.detail.tableStatus === "insufficient_data" &&
          outcome.detail.tablePurpose === "comparison",
        `detail=${JSON.stringify(outcome.detail)}`
      )
    );

  }

  // ==========================================================
  // Test B: Comparison Tableで3/5件しか取得できない -> 3件のみ生成、
  // 2件を捏造しない
  // ==========================================================

  {
    const threeEvents: ArtifactBlock[] = [
      structuredEvent(0, "名古屋マラソン", [
        { label: "イベント名", value: "名古屋マラソン" },
        { label: "地域", value: "名古屋市" },
      ]),
      structuredEvent(1, "豊田マラソン", [
        { label: "イベント名", value: "豊田マラソン" },
        { label: "地域", value: "豊田市" },
      ]),
      structuredEvent(2, "岡崎シティマラソン", [
        { label: "イベント名", value: "岡崎シティマラソン" },
        { label: "地域", value: "岡崎市" },
      ]),
    ];

    const outcome = buildBlocksForMutationKind(
      "table",
      "5件、イベント名・地域で比較表にして",
      normalPlan(),
      threeEvents
    );

    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestB] 5件要求・3件しか存在しない場合、3行のみ生成し2件を捏造しない",
        outcome.blocks !== null &&
          table !== undefined &&
          table.rows.length === 3 &&
          outcome.detail.tableRowCount === 3 &&
          outcome.detail.tableRequestedRowCount === 5,
        `rows=${JSON.stringify(table?.rows)}, detail=${JSON.stringify(outcome.detail)}`
      )
    );

  }

  // ==========================================================
  // Test C: Markdown番号付きEntity + nested fields -> fieldsが正しく
  // 生成される(Phase82-B、実DBで確認された実障害の再現)
  // ==========================================================

  {
    const parsed = parseStructuredEntitiesFromText(NESTED_BOLD_ANSWER);

    results.push(
      check(
        "[TestC-1] ネストした太字箇条書き(- **label**: value)からも3件のEntityが構造化される",
        parsed !== null && parsed.length === 3,
        `parsed=${JSON.stringify(parsed)}`
      )
    );

    results.push(
      check(
        "[TestC-2] titleはMarkdown強調記号(**)を含まないクリーンな文字列になる",
        parsed !== null && parsed[0].title === "名古屋マラソン",
        `title=${JSON.stringify(parsed?.[0].title)}`
      )
    );

    results.push(
      check(
        "[TestC-3] 各Entityが4件のfields(対象者/競技/特徴/参加しやすい理由)を、強調記号を含まないlabelで保持する",
        parsed !== null &&
          parsed[0].fields.length === 4 &&
          parsed[0].fields.some((f) => f.label === "対象者" && f.value === "一般（学生を含む）") &&
          parsed[0].fields.some((f) => f.label === "参加しやすい理由" && f.value === "エントリー枠が広い"),
        `fields=${JSON.stringify(parsed?.[0].fields)}`
      )
    );

  }

  // ==========================================================
  // Test D: 5件のExample Entity -> 5行のComparison Table
  // ==========================================================

  {
    const fiveEvents: ArtifactBlock[] = Array.from({ length: 5 }, (_, i) =>
      structuredEvent(i, `イベント${i + 1}`, [
        { label: "イベント名", value: `イベント${i + 1}` },
        { label: "地域", value: "愛知県" },
      ])
    );

    const table = buildComparisonTableFromBlocks(fiveEvents, ["イベント名", "地域"], 0);

    results.push(
      check(
        "[TestD] 5件のRow Entityから5行のComparison Tableが生成される",
        table !== null && table.rows.length === 5,
        `rowCount=${table?.rows.length}`
      )
    );

  }

  // ==========================================================
  // Test E: 比較軸6項目 -> columnsが6項目になる
  // ==========================================================

  {
    const input =
      "愛知県の大学生が参加しやすいスポーツイベントについて調査して。イベントを5件、イベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして。";

    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[TestE] ユーザー指定の6項目がそのままcolumnsとして抽出される",
        JSON.stringify(columns) ===
          JSON.stringify(["イベント名", "地域", "対象者", "競技", "特徴", "参加しやすい理由"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  // ==========================================================
  // Test F: Evidence Table -> 既存のEvidence Table挙動を維持
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
        "[TestF] 「根拠を表にして」は引き続きEvidence Table(主張/出典/確信度)を作る(comparison専用経路の影響を受けない)",
        outcome.blocks !== null &&
          outcome.detail.tablePurpose === "evidence" &&
          table !== undefined &&
          JSON.stringify(table.columns) === JSON.stringify(["主張", "出典", "確信度"]),
        `detail=${JSON.stringify(outcome.detail)}, columns=${JSON.stringify(table?.columns)}`
      )
    );

  }

  // ==========================================================
  // Test G: Research -> Example -> Tableの3ターン
  // (Phase81が特定した実運用フローそのものを、実LLM/実Search無しで
  // 決定論的に再現する)
  // ==========================================================

  {
    // Turn1: 「愛知県の大学生が参加しやすいスポーツイベントについて
    // 調査して。市場・参加傾向・課題も整理して。」(Table要求は無い)
    const turn1Plan = normalPlan({
      answer: "愛知県では大学生向けのスポーツイベントが複数開催されており、参加傾向として友人同士の参加が多い一方、認知不足が課題です。",
      keyFindings: ["友人同士での参加が多い", "認知不足が参加の障壁"],
      evidence: [{ id: "e1", claim: "スポーツ庁の調査結果", source: "https://example.com/report", confidence: "high" }],
    });

    const turn1Outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "愛知県の大学生が参加しやすいスポーツイベントについて調査して。市場・参加傾向・課題も整理して。",
      turn1Plan,
      []
    );

    results.push(
      check(
        "[TestG-1] Turn1(Research単体、Table要求なし)はResearch Blockのみを生成する",
        turn1Outcome.blocks !== null &&
          turn1Outcome.blocks.some((b) => b.type === "research_summary") &&
          !turn1Outcome.blocks.some((b) => b.type === "table")
      )
    );

    // Turn2: Phase82-CによりResearch Capability経由になる想定
    // (この統合テストではcapability="research"を直接与える——
    // classifyIntent()自体の判定はtests/tact/intent/classifyIntent.test.ts
    // のPhase82-Jケースで別途検証済み)。答えはPhase81実DBで確認された
    // 実際のフォーマット(ネストした太字箇条書き)を模す。
    const turn2Plan = normalPlan({
      answer: NESTED_BOLD_ANSWER,
      keyFindings: [],
      evidence: [
        {
          id: "e2",
          claim: "愛知県スポーツイベント一覧",
          source: "https://example.com/events",
          confidence: "medium",
          snippet: NESTED_BOLD_EVIDENCE_SNIPPET,
        },
      ],
    });

    const turn2Outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "愛知県内・東海地方で、大学生が実際に参加しているスポーツイベントの具体例を5件追加して。イベント名、対象者、競技、特徴、参加しやすい理由も整理して。",
      turn2Plan,
      turn1Outcome.blocks ?? []
    );

    const structuredExampleCount =
      turn2Outcome.blocks?.filter((b) => b.type === "example" && !!b.fields && b.fields.length > 0).length ?? 0;

    results.push(
      check(
        "[TestG-2] Turn2(Table要求を伴わないResearch)でもRow Entity(fields付きExampleBlock)が3件蓄積される(Phase82-D)",
        turn2Outcome.blocks !== null && structuredExampleCount === 3,
        `structuredExampleCount=${structuredExampleCount}`
      )
    );

    results.push(
      check(
        "[TestG-3] Turn2でもTable Blockは生成されない(Table要求が無いため、Phase82-D「意図せず生成しない」との両立)",
        turn2Outcome.blocks !== null && !turn2Outcome.blocks.some((b) => b.type === "table")
      )
    );

    results.push(
      check(
        "[TestG-4] Turn1のResearch Blockが消えずに残る",
        turn2Outcome.blocks !== null && turn2Outcome.blocks.some((b) => b.type === "research_summary")
      )
    );

    // Turn3: 「ここまで整理したイベント事例を、6項目で比較表にして」
    // -> kind="table"(chat capability経由でも成立する、Research
    // Capabilityは不要)。applyArtifactMutation()と同じ経路で
    // buildBlocksForMutationKind("table", ...)を直接呼ぶ。
    const turn3Outcome = buildBlocksForMutationKind(
      "table",
      "ここまで整理したイベント事例を、イベント名・地域・対象者・競技・特徴・参加しやすい理由の6項目で比較表にして。",
      normalPlan(),
      turn2Outcome.blocks ?? []
    );

    const comparisonTable = turn3Outcome.blocks?.find(
      (b): b is TableBlock => b.type === "table" && b.tablePurpose === "comparison"
    );

    results.push(
      check(
        "[TestG-5] Turn3でComparison Tableが実際に生成される(Research->Example->Tableの3ターン接続)",
        turn3Outcome.blocks !== null &&
          comparisonTable !== undefined &&
          comparisonTable.rows.length === 3,
        `detail=${JSON.stringify(turn3Outcome.detail)}, table=${JSON.stringify(comparisonTable)}`
      )
    );

    results.push(
      check(
        "[TestG-6] Rowは出典(URL/確信度)ではなく比較対象の属性値そのもの。実際にfieldsとして" +
          "取得できた列(対象者/競技/特徴/参加しやすい理由)は正しい値を持ち、番号付き項目の" +
          "タイトル(「名古屋マラソン」)自体はfieldsに含まれないためイベント名/地域列は" +
          "架空の値で埋めず「情報未確認」になる(Phase82絶対条件3: 確認できない情報を推測・" +
          "捏造しない。番号付きリスト形式ではタイトル行に列ラベルが無いため、この列だけは" +
          "情報未確認になるという既知の制約——Markdown Table形式ならヘッダー行が" +
          "そのままfieldsに含まれるため発生しない、Phase80 Reality Testで確認済み)",
        comparisonTable !== undefined &&
          comparisonTable.rows[0][0] === "情報未確認" &&
          comparisonTable.rows[0][1] === "情報未確認" &&
          comparisonTable.rows[0][2] === "一般（学生を含む）" &&
          comparisonTable.rows[0][3] === "マラソン" &&
          !comparisonTable.rows.flat().includes("株式会社") &&
          comparisonTable.rows.every((r) => r.every((cell) => cell === "情報未確認" || cell.length > 0)),
        `rows=${JSON.stringify(comparisonTable?.rows)}`
      )
    );

    results.push(
      check(
        "[TestG-7] 各Rowにevidence traceability(rowSourceEvidenceIds)が付与される",
        comparisonTable !== undefined &&
          comparisonTable.rowSourceEvidenceIds !== undefined &&
          comparisonTable.rowSourceEvidenceIds.every((ids) => ids.includes("e2")),
        `rowSourceEvidenceIds=${JSON.stringify(comparisonTable?.rowSourceEvidenceIds)}`
      )
    );

  }

  // ==========================================================
  // Test H: Research -> Tableの2ターン
  // ==========================================================

  {
    const turn1Plan = normalPlan({
      answer: `
主要企業3社の売上高を確認しました。

| 企業名 | 売上高 |
|---|---|
| A社 | 120 |
| B社 | 95 |
| C社 | 80 |
`,
      keyFindings: [],
      evidence: [
        {
          id: "e3",
          claim: "各社決算資料より",
          source: "https://example.com/ir",
          confidence: "high",
          snippet: "A社の売上高は120億円、B社の売上高は95億円、C社の売上高は80億円と各社の決算資料で発表された。",
        },
      ],
    });

    const turn1Outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "主要企業について調査して。",
      turn1Plan,
      []
    );

    const turn2Outcome = buildBlocksForMutationKind(
      "table",
      "企業名・売上高で比較表にして。",
      normalPlan(),
      turn1Outcome.blocks ?? []
    );

    const table = turn2Outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestH] Research(Table要求なし)->Table(2ターン目)で正しくComparison Tableが生成される",
        turn2Outcome.blocks !== null &&
          table !== undefined &&
          table.tablePurpose === "comparison" &&
          table.rows.length === 3,
        `detail=${JSON.stringify(turn2Outcome.detail)}`
      )
    );

  }

  // ==========================================================
  // Test I: Research単体 -> 追加Tableを生成しない
  // ==========================================================

  {
    const plan = normalPlan({
      answer: "愛知県の大学生のスポーツ参加傾向について、一般的な知見を整理しました。",
      keyFindings: ["参加率は緩やかに増加傾向"],
      evidence: [],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "愛知県の大学生のスポーツ参加について調査して",
      plan,
      []
    );

    results.push(
      check(
        "[TestI] Research単体(Table/Chart要求なし)ではTable Blockが生成されない(Phase82-DがTest Aの挙動を壊さない確認)",
        outcome.blocks !== null && !outcome.blocks.some((b) => b.type === "table")
      )
    );

  }

  // ==========================================================
  // Test L: 不足時Supplemental Research -> 既存Pipelineを1回だけ利用
  // (applyArtifactMutation()のkind!=="research"分岐と同じ構成を、
  // 純粋関数の組み合わせとして直接検証する)
  // ==========================================================

  {
    let callCount = 0;

    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      callCount += 1;
      return {
        success: true,
        answer: `
追加で以下の2件が確認できました。

| イベント名 | 地域 |
|---|---|
| 岡崎シティマラソン | 岡崎市 |
| 一宮七夕マラソン | 一宮市 |
`,
        evidence: [
          {
            id: "e4",
            claim: "追加調査結果",
            source: "https://example.com/more",
            confidence: "medium",
            snippet: "岡崎シティマラソンは岡崎市で開催される。一宮七夕マラソンは一宮市で開催される。",
          },
        ],
        metadata: makeMetadata(),
      };
    });

    const existingBlocks: ArtifactBlock[] = [
      structuredEvent(0, "名古屋マラソン", [
        { label: "イベント名", value: "名古屋マラソン" },
        { label: "地域", value: "名古屋市" },
      ]),
    ];

    const userInput = "追加で調査してください。イベントを3件、イベント名・地域で比較表にして。";

    const tablePurpose = classifyTablePurpose(userInput);
    const requestedRowCount = parseRequestedRowCount(userInput);

    const needsResearch = needsSupplementalResearchForArtifact("table", existingBlocks, {
      tablePurpose,
      requestedRowCount,
    });

    const workingBlocks = needsResearch
      ? mergeSupplementalRowEntities(
          existingBlocks,
          await runSupplementalResearchForArtifact(undefined, userInput)
        )
      : existingBlocks;

    const outcome = buildBlocksForMutationKind("table", userInput, normalPlan(), workingBlocks);
    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestL-1] 要求件数に届かない場合、Supplemental Researchが呼ばれる",
        needsResearch === true
      )
    );

    results.push(
      check(
        "[TestL-2] Supplemental Researchは既存Pipeline(runSupplementalResearchForArtifact)経由で1回だけ実行される",
        callCount === 1,
        `callCount=${callCount}`
      )
    );

    results.push(
      check(
        "[TestL-3] Supplementalで取得した2件が既存1件とマージされ、3行×2列(イベント名・地域)の" +
          "Comparison Tableが生成される(架空の値・列が混入しない)",
        outcome.blocks !== null &&
          table !== undefined &&
          table.rows.length === 3 &&
          JSON.stringify(table.columns) === JSON.stringify(["イベント名", "地域"]) &&
          table.rows.every((r) => r.length === 2 && r.every((cell) => cell !== "情報未確認")),
        `columns=${JSON.stringify(table?.columns)}, rows=${JSON.stringify(table?.rows)}`
      )
    );

  }

  // ==========================================================
  // Test M: No Fabrication(値の無いfieldは「情報未確認」、架空の値を
  // 作らない)
  // ==========================================================

  {
    const partialEvents: ArtifactBlock[] = [
      structuredEvent(0, "名古屋マラソン", [{ label: "イベント名", value: "名古屋マラソン" }]),
      structuredEvent(1, "豊田マラソン", [
        { label: "イベント名", value: "豊田マラソン" },
        { label: "地域", value: "豊田市" },
      ]),
    ];

    const table = buildComparisonTableFromBlocks(partialEvents, ["イベント名", "地域"], 0);

    results.push(
      check(
        "[TestM] 対応する値が無い列は架空の値ではなく「情報未確認」になる",
        table !== null && table.rows[0][1] === "情報未確認",
        `row=${JSON.stringify(table?.rows[0])}`
      )
    );

  }

  // ==========================================================
  // Test N: Source Traceability
  // ==========================================================

  {
    const tracedEvents: ArtifactBlock[] = [
      structuredEvent(
        0,
        "名古屋マラソン",
        [{ label: "イベント名", value: "名古屋マラソン" }],
        ["ev-1", "ev-2"]
      ),
      structuredEvent(
        1,
        "豊田マラソン",
        [{ label: "イベント名", value: "豊田マラソン" }],
        ["ev-3"]
      ),
    ];

    const table = buildComparisonTableFromBlocks(tracedEvents, ["イベント名"], 0);

    results.push(
      check(
        "[TestN] 各RowのsourceEvidenceIdsが元Example BlockのsourceEvidenceIdsをそのまま引き継ぐ",
        table !== null &&
          table.rowSourceEvidenceIds !== undefined &&
          JSON.stringify(table.rowSourceEvidenceIds[0]) === JSON.stringify(["ev-1", "ev-2"]) &&
          JSON.stringify(table.rowSourceEvidenceIds[1]) === JSON.stringify(["ev-3"]),
        `rowSourceEvidenceIds=${JSON.stringify(table?.rowSourceEvidenceIds)}`
      )
    );

  }

  return summarize("tact-multi-turn comparison table connection (Phase 82)", results);

}
