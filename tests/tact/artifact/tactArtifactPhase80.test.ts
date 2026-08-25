// =========================
// TACT Research + Comparison Table 統合 Regression (Phase 80)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsの
// buildResearchOutcomeWithOptionalTable()(新設、Research kindから
// Table/Chart構築フェーズへ継続する統合ロジック)、
// core/tact-conversation/artifactMutation.tsのhasTableIntent()・
// hasChartIntent()・appendRowEntitiesFromText()(Phase79からの独立
// 抽出)。
//
// 環境制約(Phase66〜79と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。Test E(Supplemental Research)のみ、既存Harness
// pattern(mock capability registration)を用いる。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import type { ResearchParams, ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import {
  buildResearchOutcomeWithOptionalTable,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import {
  hasTableIntent,
  hasChartIntent,
  buildMutationConfirmation,
} from "../../../core/tact-conversation/artifactMutation";
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

const FIVE_EVENT_TABLE_ANSWER = `
愛知県内・東海地方で大学生が参加しやすいスポーツイベントについて、5件確認しました。

| イベント名 | 地域 | 対象者 | 競技 | 特徴 | 参加しやすい理由 |
|---|---|---|---|---|---|
| 名古屋マラソン | 名古屋市 | 一般・大学生 | マラソン | 大規模イベント | 全国規模の知名度とアクセスの良さ |
| 愛知県民サッカー大会 | 愛知県全域 | 一般・学生 | サッカー | 地元住民がチームを組んで参加 | 参加チーム数が多く地域交流ができる |
| 名古屋ウィメンズマラソン | 名古屋市 | 女性一般・学生 | マラソン | 女性の参加を重視 | 応援が多く安心感がある |
| パラスポーツ体験デー | 愛知県 | 一般・学生 | パラスポーツ | 多様な競技を体験できる | 障害者スポーツへの理解を深められる |
| eスポーツチャレンジ | 名古屋市 | 一般・大学生 | eスポーツ | アジア大会に向けたイベント | eスポーツへの関心が高く参加しやすい |

以上が確認できた5件です。
`;

const FOUR_EVENT_TABLE_ANSWER = `
確認できたのは以下の4件でした。

| イベント名 | 地域 | 対象者 | 競技 | 特徴 | 参加しやすい理由 |
|---|---|---|---|---|---|
| 名古屋マラソン | 名古屋市 | 一般・大学生 | マラソン | 大規模イベント | 全国規模の知名度とアクセスの良さ |
| 愛知県民サッカー大会 | 愛知県全域 | 一般・学生 | サッカー | 地元住民がチームを組んで参加 | 参加チーム数が多く地域交流ができる |
| 名古屋ウィメンズマラソン | 名古屋市 | 女性一般・学生 | マラソン | 女性の参加を重視 | 応援が多く安心感がある |
| パラスポーツ体験デー | 愛知県 | 一般・学生 | パラスポーツ | 多様な競技を体験できる | 障害者スポーツへの理解を深められる |
`;

const REVENUE_TABLE_ANSWER = `
主要企業3社の売上高を確認しました。

| 企業名 | 売上高 |
|---|---|
| A社 | 120 |
| B社 | 95 |
| C社 | 80 |
`;

// Phase83(Evidence Grounding): FIVE/FOUR_EVENT_TABLE_ANSWERの各Rowの
// 固有名詞・属性値をすべて実際に含むEvidence本文。groundParsedEntities()
// が「Evidenceに存在する固有名詞・属性のみを採用する」ため、テスト用の
// answerに登場する内容が実際にEvidence側にも存在する状態を用意する
// (実運用でSearch Resultのsnippetに具体的な事例が書かれているケースを
// 模す)。
const FIVE_EVENT_EVIDENCE_SNIPPET =
  "名古屋マラソンは名古屋市で開催される大規模なマラソン大会で、対象者は一般・大学生、競技はマラソン。" +
  "特徴は大規模イベントで、参加しやすい理由は全国規模の知名度とアクセスの良さ。" +
  "愛知県民サッカー大会は愛知県全域で開催され、対象者は一般・学生、競技はサッカー。" +
  "地元住民がチームを組んで参加という特徴があり、参加チーム数が多く地域交流ができる点が参加しやすい理由。" +
  "名古屋ウィメンズマラソンは名古屋市で開催、対象者は女性一般・学生、競技はマラソン。" +
  "女性の参加を重視という特徴で、応援が多く安心感がある点が参加しやすい理由。" +
  "パラスポーツ体験デーは愛知県で開催、対象者は一般・学生、競技はパラスポーツ。" +
  "多様な競技を体験できる特徴があり、障害者スポーツへの理解を深められる点が参加しやすい理由。" +
  "eスポーツチャレンジは名古屋市で開催、対象者は一般・大学生、競技はeスポーツ。" +
  "アジア大会に向けたイベントという特徴で、eスポーツへの関心が高く参加しやすい点が理由。";

const REVENUE_EVIDENCE_SNIPPET =
  "A社の売上高は120億円、B社の売上高は95億円、C社の売上高は80億円と各社の決算資料で発表された。";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // hasTableIntent() / hasChartIntent(): 独立公開された判定
  // ==========================================================

  results.push(
    check(
      "[IntentA] 「調査して、5件をイベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして」-> hasTableIntent=true",
      hasTableIntent("愛知県の大学生が参加しやすいスポーツイベントについて調査して、5件をイベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして")
    )
  );

  results.push(
    check(
      "[IntentB] 「愛知県の大学生のスポーツ参加について調査して」(Table要求なし) -> hasTableIntent=false",
      !hasTableIntent("愛知県の大学生のスポーツ参加について調査して")
    )
  );

  results.push(
    check(
      "[IntentC] 「調査して、グラフにして」-> hasChartIntent=true",
      hasChartIntent("主要企業について調査して、売上高をグラフにして")
    )
  );

  // ==========================================================
  // Test A: Researchのみ
  // ==========================================================

  {
    const plan = normalPlan({
      answer: "愛知県の大学生のスポーツ参加傾向について、一般的な知見を整理しました。",
      keyFindings: ["大学生の participation rate は全国平均よりやや低い"],
      evidence: [{ id: "e1", claim: "スポーツ庁調査による参加率データ", source: "https://example.com/a", confidence: "medium" }],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "愛知県の大学生のスポーツ参加について調査して",
      plan,
      []
    );

    results.push(
      check(
        "[TestA-1] Table/Chart要求が無い場合、Table/Chart関連detailは設定されない",
        outcome.blocks !== null &&
          outcome.detail.tableStatus === undefined &&
          outcome.detail.chartStatus === undefined,
        `detail=${JSON.stringify(outcome.detail)}`
      )
    );

    results.push(
      check(
        "[TestA-2] Research BlockGroup(ResearchSummary/Finding/Evidence)は通常通り生成される",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "research_summary") &&
          outcome.blocks.some((b) => b.type === "finding") &&
          outcome.blocks.some((b) => b.type === "evidence")
      )
    );

    results.push(
      check(
        "[TestA-3] Table Blockは1件も生成されない",
        outcome.blocks !== null && !outcome.blocks.some((b) => b.type === "table")
      )
    );

  }

  // ==========================================================
  // Test B・C・D: Research + Comparison Table(5件要求・5件存在)
  // ==========================================================

  {
    const userInput =
      "愛知県の大学生が参加しやすいスポーツイベントについて調査して。イベントを5件、イベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして。";

    const plan = normalPlan({
      answer: FIVE_EVENT_TABLE_ANSWER,
      keyFindings: ["名古屋マラソンは知名度とアクセスの良さが強み"],
      evidence: [
        {
          id: "e1",
          claim: "愛知県開催の大会一覧",
          source: "https://example.com/sports",
          confidence: "high",
          snippet: FIVE_EVENT_EVIDENCE_SNIPPET,
        },
      ],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);

    results.push(
      check(
        "[TestB-1] Research Block(Finding/Evidence)とComparison Table Blockが共存する",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "finding") &&
          outcome.blocks.some((b) => b.type === "evidence") &&
          outcome.blocks.some((b) => b.type === "table" && b.tablePurpose === "comparison")
      )
    );

    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestC] Research回答内のMarkdown TableがRow Entity化され、RowはEvidenceの主張ではなくEntity(イベント名)になる",
        table !== undefined && table.rows.some((r) => r[0] === "名古屋マラソン"),
        `rows[0]=${JSON.stringify(table?.rows[0])}`
      )
    );

    results.push(
      check(
        "[TestD] 5件要求・5件存在 -> 5行のComparison Tableが生成される",
        table !== undefined && table.rows.length === 5,
        `rowCount=${table?.rows.length}`
      )
    );

    results.push(
      check(
        "[TestB-2] columnsがユーザー指定の6項目そのまま(「主張/出典/確信度」に置き換わらない)",
        table !== undefined &&
          JSON.stringify(table.columns) ===
            JSON.stringify(["イベント名", "地域", "対象者", "競技", "特徴", "参加しやすい理由"]),
        `columns=${JSON.stringify(table?.columns)}`
      )
    );

    results.push(
      check(
        "[TestB-3] Conversation応答がResearchとTable両方の実行内容を反映する",
        (() => {
          const msg = buildMutationConfirmation("research", userInput, {
            isNewArtifact: true,
            ...outcome.detail,
          });
          return msg.includes("調査しました") && msg.includes("5件");
        })(),
      )
    );

  }

  // ==========================================================
  // Test E: 5件要求、4件しか存在 -> Supplemental Researchを試みても
  // なお4件 -> 4行 + 不足を明示(件数を偽らない)
  // ==========================================================

  {
    let supplementalCalled = false;

    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      supplementalCalled = true;
      return {
        success: true,
        answer: "追加調査でも新しいイベントは確認できませんでした。",
        evidence: [],
        metadata: makeMetadata(),
      };
    });

    const userInput =
      "愛知県の大学生が参加しやすいスポーツイベントについて調査して。イベントを5件、イベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして。";

    const plan = normalPlan({
      answer: FOUR_EVENT_TABLE_ANSWER,
      keyFindings: [],
      evidence: [
        {
          id: "e0",
          claim: "愛知県開催の大会一覧",
          source: "https://example.com/sports",
          confidence: "high",
          snippet: FIVE_EVENT_EVIDENCE_SNIPPET,
        },
      ],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);

    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestE-1] 要求5件に対しRow Entityが4件しか無い場合、Supplemental Researchが試みられる",
        supplementalCalled
      )
    );

    results.push(
      check(
        "[TestE-2] Supplemental Researchでも増えなければ、4件のまま(架空の5件目を作らない)",
        table !== undefined && table.rows.length === 4,
        `rowCount=${table?.rows.length}`
      )
    );

    results.push(
      check(
        "[TestE-3] detail.tableRowCount=4・tableRequestedRowCount=5が正確に報告される",
        outcome.detail.tableRowCount === 4 && outcome.detail.tableRequestedRowCount === 5
      )
    );

    results.push(
      check(
        "[TestE-4] Conversation応答が「4件」「残り1件」「推測で補完していません」を含む",
        (() => {
          const msg = buildMutationConfirmation("research", userInput, {
            isNewArtifact: true,
            ...outcome.detail,
          });
          return msg.includes("4件") && msg.includes("1件") && msg.includes("推測で補完していません");
        })(),
      )
    );

  }

  // ==========================================================
  // Test F: Research + Evidence Table -> Comparison TableではなくEvidence Table
  // ==========================================================

  {
    const userInput = "主要スポーツ庁の調査について調べて、根拠を表にして";

    const plan = normalPlan({
      answer: "スポーツ庁の調査結果を確認しました。",
      keyFindings: ["参加率は緩やかに増加傾向"],
      evidence: [
        { id: "e1", claim: "令和元年スポーツ庁世論調査", source: "https://example.com/report", confidence: "high" },
        { id: "e2", claim: "地域スポーツイベントの効果分析", source: "https://example.com/paper", confidence: "medium" },
      ],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);

    const table = outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[TestF] 「根拠を表にして」はComparison TableではなくEvidence Table(主張/出典/確信度)になる",
        table !== undefined &&
          table.tablePurpose === "evidence" &&
          table.columns[0] === "主張",
        `table=${JSON.stringify(table)}`
      )
    );

  }

  // ==========================================================
  // Test G・H: Research + Chart / Research + Comparison Table + Chart
  // ==========================================================

  {
    const userInput = "主要企業について調査して。企業を3社、企業名・売上高で比較表にして、さらにグラフにして。";

    const plan = normalPlan({
      answer: REVENUE_TABLE_ANSWER,
      keyFindings: [],
      evidence: [
        {
          id: "e1",
          claim: "各社決算資料より",
          source: "https://example.com/ir",
          confidence: "high",
          snippet: REVENUE_EVIDENCE_SNIPPET,
        },
      ],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);

    results.push(
      check(
        "[TestH-1] Comparison TableとChartの両方がArtifactへ反映される",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "table" && b.tablePurpose === "comparison") &&
          outcome.blocks.some((b) => b.type === "chart"),
        `types=${outcome.blocks?.map((b) => b.type).join(",")}`
      )
    );

    const chart = outcome.blocks?.find((b) => b.type === "chart");

    results.push(
      check(
        "[TestG] Chart要求が認識され、数値データからChart Blockが構築される(架空数値でない)",
        chart !== undefined &&
          chart.type === "chart" &&
          chart.data.length === 3 &&
          chart.data.some((d) => d.label === "A社" && d.value === 120)
      )
    );

    results.push(
      check(
        "[TestH-2] detail.chartStatusが'created'として報告される",
        outcome.detail.chartStatus === "created"
      )
    );

  }

  // ==========================================================
  // Test I: 架空データ防止 -> 根拠のないRowを生成しない
  // ==========================================================

  {
    // Research回答がMarkdown Table等の構造を一切含まない自由文の場合、
    // Comparison Tableは作れない(架空のRowを生成しない)。Research
    // 自体の結果(Finding/Evidence)は保持されたままであることも確認する。
    // 「5件」要求に対しRow Entityが0件のため、内部でSupplemental
    // Researchが試みられる(Test E同様)。既存Harness patternに従い
    // 明示的にmock capabilityを登録し、実APIが呼ばれないことと、
    // Supplementalでも構造化データが得られない場合の挙動を制御する
    // (Phase78で確立した「userIdはundefinedを渡す」lessonをここでも守る)。
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "追加調査でも具体的な一覧は確認できませんでした。",
      evidence: [],
      metadata: makeMetadata(),
    }));

    const userInput = "愛知県の大学生向けスポーツイベントについて調査して、5件を比較表にして";

    const plan = normalPlan({
      answer: "愛知県内には複数のスポーツイベントが存在しますが、具体的な一覧は今回の調査では確認できませんでした。",
      keyFindings: ["具体的なイベント名までは特定できなかった"],
      evidence: [],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(undefined, userInput, plan, []);

    results.push(
      check(
        "[TestI-1] 構造化できるデータが無い場合、Table Blockは生成されない(架空のRowを作らない)",
        outcome.blocks !== null && !outcome.blocks.some((b) => b.type === "table")
      )
    );

    results.push(
      check(
        "[TestI-2] tableStatus='insufficient_data'として正直に報告される",
        outcome.detail.tableStatus === "insufficient_data" && outcome.detail.tablePurpose === "comparison"
      )
    );

    results.push(
      check(
        "[TestI-3] Table構築が失敗してもResearch結果(Finding)は失われない",
        outcome.blocks !== null && outcome.blocks.some((b) => b.type === "finding")
      )
    );

  }

  // ==========================================================
  // Row Entityがsupplemental researchを介さずAppendされる場合の
  // Evidence Traceability確認(既存Blockを壊さないことの確認、Test I系)
  // ==========================================================

  {
    const existingBlocks: ArtifactBlock[] = [
      { id: "old-1", type: "finding", content: "既存の発見", order: 0, createdAt: "x", updatedAt: "x" },
    ];

    const plan = normalPlan({
      answer: FIVE_EVENT_TABLE_ANSWER,
      keyFindings: ["新しい発見"],
      evidence: [],
    });

    const outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      "追加で愛知県の大学生が参加しやすいスポーツイベントを調査して、イベント名・地域・対象者・競技・特徴・参加しやすい理由で比較表にして",
      plan,
      existingBlocks
    );

    results.push(
      check(
        "[Regression] 既存Blockが消えずに新しいResearch/Table Blockが追記される",
        outcome.blocks !== null && outcome.blocks.some((b) => b.id === "old-1")
      )
    );

  }

  return summarize("tact-research-comparison-table integration (Phase 80)", results);

}
