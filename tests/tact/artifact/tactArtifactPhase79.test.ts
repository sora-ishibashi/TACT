// =========================
// TACT Comparison Table Regression (Phase 79)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.tsの
// classifyTablePurpose()・parseComparisonColumns()・
// parseRequestedRowCount()・parseStructuredEntitiesFromText()・
// buildExampleMutationBlocks()、core/tact-artifact/blocks.tsの
// buildComparisonTableFromBlocks()、core/tact-conversation/
// orchestration.tsのbuildBlocksForMutationKind()(table分岐)・
// needsSupplementalResearchForArtifact()・mergeSupplementalRowEntities()。
// いずれも純粋関数のみ(DB/LLM/Search API呼び出しなし)。

import {
  classifyTablePurpose,
  parseComparisonColumns,
  parseRequestedRowCount,
  parseStructuredEntitiesFromText,
  buildExampleMutationBlocks,
  buildMutationConfirmation,
} from "../../../core/tact-conversation/artifactMutation";
import {
  buildBlocksForMutationKind,
  needsSupplementalResearchForArtifact,
  mergeSupplementalRowEntities,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import {
  buildComparisonTableFromBlocks,
  buildChartFromTable,
  createExampleBlock,
  createEvidenceBlock,
} from "../../../core/tact-artifact/blocks";
import type { ArtifactBlock, TableBlock } from "../../../core/tact-artifact/types";
import { check, summarize, type CheckResult } from "../lib/check";

function normalPlan(
  overrides: Partial<Extract<ConversationOrchestrationPlan, { kind: "normal" }>> = {}
): Extract<ConversationOrchestrationPlan, { kind: "normal" }> {

  return {
    kind: "normal",
    executionId: "exec-1",
    status: "completed",
    answer: "デフォルト回答",
    capability: "orchestrator",
    evidence: [],
    keyFindings: [],
    ...overrides,
  };

}

const EVENT_MARKDOWN_ANSWER = `
以下の5件が確認できました。

| イベント名 | 地域 | 対象者 | 特徴 | 参加しやすい理由 |
|---|---|---|---|---|
| 名古屋ウィメンズマラソン | 名古屋市 | 一般・大学生 | 国内最大級の女性マラソン | エントリー枠が広い |
| 豊田マラソン | 豊田市 | 学生・一般 | 地域密着型 | 参加費が安い |
| 岐阜清流ハーフマラソン | 岐阜市 | 大学生中心 | 大学連携イベント | 大学から交通費補助あり |
`;

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test A: 「根拠を表にして」 -> Evidence Table
  // ==========================================================

  results.push(
    check(
      "[TestA] 「根拠を表にして」-> classifyTablePurpose()='evidence'",
      classifyTablePurpose("根拠を表にして") === "evidence"
    )
  );

  results.push(
    check(
      "[TestA-2] 「出典を一覧にして」「エビデンスを表にして」も'evidence'",
      classifyTablePurpose("出典を一覧にして") === "evidence" &&
        classifyTablePurpose("エビデンスを表にして") === "evidence"
    )
  );

  // ==========================================================
  // Test B: 「イベントを5件、イベント名・地域・対象者・特徴で比較表に
  // して」 -> Comparison Table(列挙・件数の抽出)
  // ==========================================================

  {
    const input = "愛知県内のイベントを5件、イベント名・地域・対象者・特徴で比較表にして";

    results.push(
      check(
        "[TestB-1] classifyTablePurpose()='comparison'",
        classifyTablePurpose(input) === "comparison"
      )
    );

    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[TestB-2] parseComparisonColumns()がユーザー指定の列をそのまま抽出する",
        JSON.stringify(columns) === JSON.stringify(["イベント名", "地域", "対象者", "特徴"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

    results.push(
      check(
        "[TestB-3] parseRequestedRowCount()が「5件」を抽出する(「5項目」等の列数と混同しない)",
        parseRequestedRowCount(input) === 5
      )
    );

  }

  {
    const input = "ここまで整理したイベント事例を、イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較表にして";

    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[TestB-4] 「Xの5項目で」形式でも、無関係な先行節(「ここまで整理した...」)を混入させずに列を抽出する",
        JSON.stringify(columns) ===
          JSON.stringify(["イベント名", "地域", "対象者", "特徴", "参加しやすい理由"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  results.push(
    check(
      "[TestB-5] 単一語(列挙ではない)の「重要度で整理して」-> undefined",
      parseComparisonColumns("重要度で整理して") === undefined
    )
  );

  // ==========================================================
  // Test C・D・E: Comparison TableのRowはEntity、列はユーザー指定、
  // 各RowにsourceEvidenceIds
  // ==========================================================

  {
    const rowEntities: ArtifactBlock[] = [
      createExampleBlock(
        "イベント名: 名古屋ウィメンズマラソン / 地域: 名古屋市",
        0,
        "名古屋ウィメンズマラソン",
        [
          { label: "イベント名", value: "名古屋ウィメンズマラソン" },
          { label: "地域", value: "名古屋市" },
          { label: "対象者", value: "一般・大学生" },
        ],
        ["ev-1", "ev-2"]
      ),
      createExampleBlock(
        "イベント名: 豊田マラソン / 地域: 豊田市",
        1,
        "豊田マラソン",
        [
          { label: "イベント名", value: "豊田マラソン" },
          { label: "地域", value: "豊田市" },
          { label: "対象者", value: "学生・一般" },
        ],
        ["ev-3"]
      ),
    ];

    const table = buildComparisonTableFromBlocks(
      rowEntities,
      ["イベント名", "地域", "対象者"],
      0,
      "イベント比較"
    );

    results.push(
      check(
        "[TestC] Comparison TableのRowはEvidenceの主張ではなく、Row Entity(イベント名等)そのものになる",
        table !== null &&
          table.rows.length === 2 &&
          table.rows[0][0] === "名古屋ウィメンズマラソン" &&
          table.rows[1][0] === "豊田マラソン",
        `table=${JSON.stringify(table)}`
      )
    );

    results.push(
      check(
        "[TestD] 指定した列がそのままTable.columnsになる(「主張・出典・確信度」に置き換わらない)",
        table !== null && JSON.stringify(table.columns) === JSON.stringify(["イベント名", "地域", "対象者"])
      )
    );

    results.push(
      check(
        "[TestD-2] tablePurpose='comparison'がmetadataとして保持される",
        table !== null && table.tablePurpose === "comparison"
      )
    );

    results.push(
      check(
        "[TestE] 各RowにrowSourceEvidenceIds(行単位のEvidence Traceability)が付く",
        table !== null &&
          table.rowSourceEvidenceIds !== undefined &&
          JSON.stringify(table.rowSourceEvidenceIds[0]) === JSON.stringify(["ev-1", "ev-2"]) &&
          JSON.stringify(table.rowSourceEvidenceIds[1]) === JSON.stringify(["ev-3"]),
        `rowSourceEvidenceIds=${JSON.stringify(table?.rowSourceEvidenceIds)}`
      )
    );

  }

  // 列名が表記ゆれの場合(完全一致しない)、情報未確認として捏造しない。
  {
    const rowEntities: ArtifactBlock[] = [
      createExampleBlock("A", 0, "A", [{ label: "イベント名", value: "Aマラソン" }]),
    ];

    const table = buildComparisonTableFromBlocks(rowEntities, ["イベント名", "参加費"], 0);

    results.push(
      check(
        "[TestD-3] 対応するfieldsが無い列は「情報未確認」になる(架空の値を作らない)",
        table !== null && table.rows[0][1] === "情報未確認",
        `row=${JSON.stringify(table?.rows[0])}`
      )
    );

  }

  // ==========================================================
  // Test F: Evidence不足時(構造化Row Entityが無い)に架空Rowを作らない
  // ==========================================================

  results.push(
    check(
      "[TestF] 構造化Row Entity(fields付きExample)が1件も無い -> buildComparisonTableFromBlocksはnull",
      buildComparisonTableFromBlocks([createExampleBlock("非構造化の事例文章", 0)], ["a", "b"], 0) === null
    )
  );

  {
    // buildBlocksForMutationKindでも、構造化Row Entityが0件なら
    // insufficient_dataまたはlegacy fallback(Evidence Tableへの
    // フォールスルー)になり、架空のComparison Row(rowCount>0な
    // のに中身が捏造)は絶対に生まれない。
    const outcome = buildBlocksForMutationKind(
      "table",
      "イベントを5件、イベント名・地域で比較表にして",
      normalPlan(),
      []
    );

    results.push(
      check(
        "[TestF-2] 構造化Row Entityも既存Example/Evidenceも無い場合 -> blocks=null(拒否、捏造しない)",
        outcome.blocks === null && outcome.detail.tablePurpose === "comparison"
      )
    );

  }

  // ==========================================================
  // parseStructuredEntitiesFromText(): Markdown Table / 番号付きリスト
  // ==========================================================

  {
    const parsed = parseStructuredEntitiesFromText(EVENT_MARKDOWN_ANSWER);

    results.push(
      check(
        "[ParseG1] Markdown Table形式のanswerから3件のEntityが構造化される",
        parsed !== null && parsed.length === 3,
        `parsed=${JSON.stringify(parsed)}`
      )
    );

    results.push(
      check(
        "[ParseG2] 各Entityのtitleは1列目(イベント名)の値になる",
        parsed !== null && parsed[0].title === "名古屋ウィメンズマラソン"
      )
    );

    results.push(
      check(
        "[ParseG3] 各Entityのfieldsにヘッダー行の列名がそのまま入る",
        parsed !== null &&
          parsed[0].fields.some((f) => f.label === "地域" && f.value === "名古屋市")
      )
    );

  }

  {
    const numberedList = `
1. イベント名: 名古屋ウィメンズマラソン
   地域: 名古屋市
   対象者: 一般・大学生
2. イベント名: 豊田マラソン
   地域: 豊田市
   対象者: 学生・一般
`;

    const parsed = parseStructuredEntitiesFromText(numberedList);

    results.push(
      check(
        "[ParseG4] 番号付きリスト+ラベル:値形式でも2件のEntityが構造化される",
        parsed !== null && parsed.length === 2 && parsed[0].title === "名古屋ウィメンズマラソン",
        `parsed=${JSON.stringify(parsed)}`
      )
    );

  }

  results.push(
    check(
      "[ParseG5] 構造化できない自由文はnull(無理に分解しない、捏造しない)",
      parseStructuredEntitiesFromText("これは普通の説明文です。特に構造化された情報はありません。") === null
    )
  );

  // ==========================================================
  // buildExampleMutationBlocks(): 「事例を5件追加して」の分解
  // ==========================================================

  {
    const blocks = buildExampleMutationBlocks(
      "愛知県内のイベントを5件追加して",
      EVENT_MARKDOWN_ANSWER,
      []
    );

    results.push(
      check(
        "[ExampleH1] 構造化できるanswerからは、1件のBlobではなく複数のExampleBlock(Row Entity)が作られる",
        blocks.length === 3 && blocks.every((b) => b.type === "example"),
        `count=${blocks.length}`
      )
    );

    results.push(
      check(
        "[ExampleH2] 各ExampleBlockがfieldsを保持する(Root Causeで指摘された、常に空だったfieldsが実際に設定される)",
        blocks.every((b) => b.type === "example" && b.fields && b.fields.length > 0)
      )
    );

  }

  {
    // 構造化できない場合は既存Phase76〜78の挙動(1件のExampleBlock)。
    const blocks = buildExampleMutationBlocks("事例を追加して", "これは普通の説明文です。", []);

    results.push(
      check(
        "[ExampleH3] 構造化できないanswerは、既存Phase76〜78通り1件のExampleBlockになる(後方互換)",
        blocks.length === 1 && blocks[0].type === "example"
      )
    );

  }

  // ==========================================================
  // Test G: Supplemental Researchによって不足Entityを補える
  // ==========================================================

  {
    const merged = mergeSupplementalRowEntities([], {
      answer: EVENT_MARKDOWN_ANSWER,
      evidence: [
        {
          id: "ev-1",
          claim: "来場者数関連の根拠",
          source: "https://example.com",
          confidence: "high",
          // Phase83(Evidence Grounding): mergeSupplementalRowEntities()が
          // Evidence本文と照合してEntityを採用するため、EVENT_MARKDOWN_ANSWER
          // の3件が実際に存在するsnippetを用意する。
          snippet:
            "名古屋ウィメンズマラソンは名古屋市で開催、対象者は一般・大学生、国内最大級の女性マラソンが特徴でエントリー枠が広い。" +
            "豊田マラソンは豊田市で開催、対象者は学生・一般、地域密着型が特徴で参加費が安い。" +
            "岐阜清流ハーフマラソンは岐阜市で開催、対象者は大学生中心、大学連携イベントが特徴で大学から交通費補助あり。",
        },
      ],
    });

    const exampleBlocks = merged.filter((b) => b.type === "example");
    const evidenceBlocks = merged.filter((b) => b.type === "evidence");

    results.push(
      check(
        "[TestG] mergeSupplementalRowEntities()が構造化Entityとevidence traceabilityの両方を追加する",
        exampleBlocks.length === 3 &&
          evidenceBlocks.length === 1 &&
          exampleBlocks.every(
            (b) => b.type === "example" && b.sourceEvidenceIds?.includes("ev-1")
          )
      )
    );

  }

  // needsSupplementalResearchForArtifact(): comparison purposeでの判定
  results.push(
    check(
      "[NeedsI1] comparison + 構造化Entity 0件 + 要求5件 -> true(追加Research要)",
      needsSupplementalResearchForArtifact("table", [], { tablePurpose: "comparison", requestedRowCount: 5 })
    )
  );

  {
    const threeEntities: ArtifactBlock[] = [
      createExampleBlock("A", 0, "A", [{ label: "x", value: "1" }]),
      createExampleBlock("B", 1, "B", [{ label: "x", value: "2" }]),
      createExampleBlock("C", 2, "C", [{ label: "x", value: "3" }]),
    ];

    results.push(
      check(
        "[NeedsI2] comparison + 構造化Entity 3件 + 要求5件 -> true(まだ不足)",
        needsSupplementalResearchForArtifact("table", threeEntities, {
          tablePurpose: "comparison",
          requestedRowCount: 5,
        })
      )
    );

    results.push(
      check(
        "[NeedsI3] comparison + 構造化Entity 3件 + 要求3件 -> false(十分)",
        !needsSupplementalResearchForArtifact("table", threeEntities, {
          tablePurpose: "comparison",
          requestedRowCount: 3,
        })
      )
    );

  }

  // ==========================================================
  // Test H: Research不足で補えない場合、件数を偽らない
  // ==========================================================

  results.push(
    check(
      "[TestH] Comparison Table: 要求5件に対し実際3件 -> Conversation応答が実数(3件)と不足数(2件)を正直に示す",
      (() => {

        const msg = buildMutationConfirmation("table", "5件比較して", {
          isNewArtifact: true,
          tableStatus: "created",
          tablePurpose: "comparison",
          tableRowCount: 3,
          tableRequestedRowCount: 5,
        });

        return msg.includes("3件") && msg.includes("2件") && msg.includes("推測で補完していません");

      })(),
    )
  );

  results.push(
    check(
      "[TestM] Comparison Table: 要求件数と一致 -> 「◯件」を含む正直な報告(不足の言及をしない)",
      (() => {

        const msg = buildMutationConfirmation("table", "5件比較して", {
          isNewArtifact: true,
          tableStatus: "created",
          tablePurpose: "comparison",
          tableRowCount: 5,
          tableRequestedRowCount: 5,
        });

        return msg.includes("5件") && !msg.includes("補完");

      })(),
    )
  );

  // ==========================================================
  // Test I・J: Comparisonの不正フォールバック禁止 / 既存Evidence Table
  // 挙動の維持
  // ==========================================================
  //
  // Phase82-A修正(Repository Evidence: Phase81投資調査): 以前はここで
  // 「構造化されていないExampleしか無い場合、Evidence Table経路へ
  // フォールスルーする」という挙動を期待していたが、これはまさに
  // Phase81で特定された不具合(比較表を要求したのに出典一覧が
  // 静かに生成される)そのものだったため、Phase82-Aで意図的に禁止
  // した。このテストは「不正フォールバックが起きないこと」を確認する
  // ものへ更新する。

  {
    // 構造化されていない(fieldsを持たない)既存Example Blockしか
    // 無い状態で「表にして」(既定でcomparison) -> Comparison Table
    // としては成立しないため、Evidence Tableへフォールバックせず
    // 拒否する(Phase82絶対条件2)。
    const unstructuredExamples: ArtifactBlock[] = [
      createExampleBlock("事例Aの説明文", 0, "事例A"),
    ];

    const outcome = buildBlocksForMutationKind("table", "表にして", normalPlan(), unstructuredExamples);

    results.push(
      check(
        "[TestI] 構造化されていないExampleしか無い場合、Evidence Tableへフォールバックせずcomparisonのまま拒否する(Phase82-A)",
        outcome.blocks === null &&
          outcome.detail.tableStatus === "insufficient_data" &&
          outcome.detail.tablePurpose === "comparison" &&
          outcome.detail.tableRowCount === 0,
        `detail=${JSON.stringify(outcome.detail)}`
      )
    );

    results.push(
      check(
        "[TestI-2] 拒否時はArtifact自体が変更されない(blocks=nullなので既存Example Blockも失われない)",
        outcome.blocks === null
      )
    );

  }

  {
    // 明示的にEvidence Tableを要求した場合の既存挙動(Phase76〜78)が
    // そのまま動く。
    const evidenceBlocks: ArtifactBlock[] = [
      createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
    ];

    const outcome = buildBlocksForMutationKind("table", "根拠を表にして", normalPlan(), evidenceBlocks);

    results.push(
      check(
        "[TestJ] 「根拠を表にして」は引き続きEvidence Table(主張/出典/確信度)を作る",
        outcome.blocks !== null &&
          outcome.detail.tablePurpose === "evidence" &&
          (outcome.blocks.find((b) => b.type === "table") as TableBlock | undefined)?.columns[0] === "主張"
      )
    );

  }

  // ==========================================================
  // Test K: Chart生成の既存ルールが壊れない(Comparison Tableでも
  // 数値列があれば作れる、無ければ作らない)
  // ==========================================================

  {
    const numericComparisonTable: TableBlock = {
      id: "t1",
      type: "table",
      title: "参加者数比較",
      columns: ["イベント名", "参加者数"],
      rows: [["A", "1200"], ["B", "800"]],
      tablePurpose: "comparison",
      rowSourceEvidenceIds: [["ev-1"], ["ev-2"]],
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    const chart = buildChartFromTable(numericComparisonTable, 1);

    results.push(
      check(
        "[TestK1] Comparison Tableでも数値列があればChartが作れる(既存buildChartFromTableは無変更)",
        chart !== null && chart.data.length === 2 && chart.data[0].value === 1200
      )
    );

  }

  {
    const textOnlyComparisonTable: TableBlock = {
      id: "t2",
      type: "table",
      columns: ["イベント名", "特徴"],
      rows: [["A", "国内最大級"]],
      tablePurpose: "comparison",
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    results.push(
      check(
        "[TestK2] 数値列が無いComparison Tableからは架空の数値でChartを作らない",
        buildChartFromTable(textOnlyComparisonTable, 1) === null
      )
    );

  }

  // ==========================================================
  // Test L: Artifact Titleが質問文全文にならない(既存deriveArtifactTitle
  // の再利用、回帰確認)
  // ==========================================================

  results.push(
    check(
      "[TestL] 比較表生成の指示文でもtitleは命令文・列挙を含まない短い形になる",
      (() => {

        // deriveArtifactTitleはbuildComparisonTableFromBlocks呼び出し側
        // (orchestration.ts)がtitleとして渡す値の生成に使われる、
        // 既存関数の再利用を回帰確認する(buildBlocksForMutationKindの
        // 実行結果から間接的に検証)。
        const outcome = buildBlocksForMutationKind(
          "table",
          "愛知県の大学生向けスポーツイベントを、イベント名・地域・対象者で比較表にして",
          normalPlan(),
          [
            createExampleBlock("A", 0, "A", [{ label: "イベント名", value: "A" }]),
            createExampleBlock("B", 1, "B", [{ label: "イベント名", value: "B" }]),
          ]
        );

        const table = outcome.blocks?.find((b) => b.type === "table") as TableBlock | undefined;

        return (
          table?.title !== undefined &&
          table.title.length < 30 &&
          !table.title.includes("比較表にして")
        );

      })(),
    )
  );

  return summarize("tact-comparison-table architecture (Phase 79)", results);

}
