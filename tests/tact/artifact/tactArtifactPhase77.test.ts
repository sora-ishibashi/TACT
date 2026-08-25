// =========================
// TACT Artifact UX / Semantic Update Refinement Regression (Phase 77)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.ts
// (deriveArtifactTitle改善・buildMutationConfirmation新設)、
// core/tact-conversation/orchestration.ts(buildBlocksForMutationKind、
// Table/Chartの「拒否」判定)、core/tact-conversation/artifactReference.ts
// (isArtifactReferenceQuestion・buildArtifactReferenceAnswer)。
// いずれも純粋関数のみ(DB/LLM/Search API呼び出しなし、Phase75/76と
// 同じ既存方針)。

import {
  deriveArtifactTitle,
  buildMutationConfirmation,
  buildResearchMutationBlocks,
} from "../../../core/tact-conversation/artifactMutation";
import {
  buildBlocksForMutationKind,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import {
  isArtifactReferenceQuestion,
  buildArtifactReferenceAnswer,
} from "../../../core/tact-conversation/artifactReference";
import {
  createEvidenceBlock,
  createExampleBlock,
  createFindingBlock,
} from "../../../core/tact-artifact/blocks";
import type { Artifact, ArtifactBlock, TableBlock } from "../../../core/tact-artifact/types";
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // 77-A: deriveArtifactTitle()
  // ==========================================================

  results.push(
    check(
      "[TitleA1] 複数文+命令文の実Reality Test入力 -> 最初の文かつ命令文を含まないtitleになる",
      deriveArtifactTitle(
        "愛知県の大学生が参加しやすいスポーツイベントについて調査して。参加者を増やすための施策を考える前提で、現状・課題・傾向を整理して。"
      ) === "愛知県の大学生が参加しやすいスポーツイベント"
    )
  );

  results.push(
    check(
      "[TitleA2] 「他大学の事例も追加して」-> 「追加して」を含まない",
      !deriveArtifactTitle("他大学の事例も追加して").includes("追加して")
    )
  );

  results.push(
    check(
      "[TitleA3] 命令文だけの入力(「調べて」)-> 空にならず安全側フォールバック",
      deriveArtifactTitle("調べて").length > 0
    )
  );

  results.push(
    check(
      "[TitleA4] 命令文を含まない短い入力はそのまま(既存Phase75挙動の維持)",
      deriveArtifactTitle("中京大学について") === "中京大学について"
    )
  );

  results.push(
    check(
      "[TitleA5] 「大学ごとに表にまとめて」-> 「まとめて」を含まない",
      !deriveArtifactTitle("大学ごとに表にまとめて").includes("まとめて")
    )
  );

  results.push(
    check(
      "[TitleA6] 「トヨタの競合について教えて」-> 「教えて」を含まない(Phase77再実装Section3)",
      !deriveArtifactTitle("トヨタの競合について教えて").includes("教えて")
    )
  );

  // ==========================================================
  // 77-B: buildMutationConfirmation() — kindごとに異なる短文
  // ==========================================================

  {
    const messages = {
      research: buildMutationConfirmation("research", "愛知県の大学生について調査して", {
        isNewArtifact: true,
        findingCount: 3,
        evidenceCount: 2,
      }),
      evidence: buildMutationConfirmation("evidence", "根拠を追加して", { isNewArtifact: false }),
      example: buildMutationConfirmation("example", "事例を追加して", { isNewArtifact: false }),
      recommendation: buildMutationConfirmation("recommendation", "施策を追加して", {
        isNewArtifact: false,
      }),
      hypothesis: buildMutationConfirmation("hypothesis", "仮説を追加して", { isNewArtifact: false }),
    };

    const allDistinct = new Set(Object.values(messages)).size === Object.values(messages).length;

    results.push(
      check(
        "[ConfirmB1] research/evidence/example/recommendation/hypothesisで全て異なるメッセージになる",
        allDistinct,
        JSON.stringify(messages)
      )
    );

    results.push(
      check(
        "[ConfirmB2] research: 実際のfindingCount/evidenceCountが文面に反映される(捏造しない)",
        messages.research.includes("3") && messages.research.includes("2"),
        messages.research
      )
    );
  }

  results.push(
    check(
      "[ConfirmB3] table: insufficient_data -> 「見送り」を含む(Artifact変更なしを示す文言)",
      buildMutationConfirmation("table", "表にして", {
        isNewArtifact: false,
        tableStatus: "insufficient_data",
      }).includes("見送")
    )
  );

  results.push(
    check(
      "[ConfirmB4] chart: insufficient_data -> 「見送り」を含む",
      buildMutationConfirmation("chart", "グラフにして", {
        isNewArtifact: false,
        chartStatus: "insufficient_data",
      }).includes("見送")
    )
  );

  results.push(
    check(
      "[ConfirmB5] table: created と updated で異なる文言になる",
      buildMutationConfirmation("table", "表にして", { isNewArtifact: false, tableStatus: "created" }) !==
        buildMutationConfirmation("table", "表にして", { isNewArtifact: false, tableStatus: "updated" })
    )
  );

  // ==========================================================
  // 77-C: buildBlocksForMutationKind() — Table/Chartの拒否判定
  // ==========================================================

  results.push(
    check(
      "[TableC1] Example/Evidenceが1件も無い -> blocks=null(Mutationを拒否)",
      buildBlocksForMutationKind("table", "表にして", normalPlan(), []).blocks === null
    )
  );

  {
    // Phase82-A修正(Repository Evidence: Phase81投資調査): 以前はここで
    // 非構造化(fieldsを持たない)ExampleBlockから「事例|詳細」形式の
    // legacy Table BlockがcomparisonリクエストのフォールバックとしてUSER
    // が要求していないEvidence Table扱いで生成されていた——Phase82-Aは
    // comparisonリクエストがEvidence Tableへ暗黙にフォールバックする
    // ことを明示的に禁止したため、非構造化Exampleだけでは「表にして」
    // (classifyTablePurpose()の既定=comparison)はもはや生成に成功
    // しない。Table生成自体が成功する経路の回帰確認は、構造化
    // (fields付き)ExampleBlockを使う形に更新する(既存のComparison
        // Table生成ロジック自体はPhase79で確立済み、ここでは「拒否判定」
    // というこのテストブロックの元々の目的——「データがあれば作れる」
    // ——をcomparisonの正しい入力形で確認し直す)。
    const structuredExample: ArtifactBlock[] = [
      createExampleBlock(
        "詳細: 事例Aの説明",
        0,
        "事例A",
        [{ label: "詳細", value: "事例Aの説明" }]
      ),
    ];

    const outcome = buildBlocksForMutationKind("table", "表にして", normalPlan(), structuredExample);

    results.push(
      check(
        "[TableC2] 構造化(fields付き)Example Blockがある -> Comparison Table Blockが実際に生成される(tableStatus='created')",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "table") &&
          outcome.detail.tableStatus === "created" &&
          outcome.detail.tablePurpose === "comparison",
        `detail=${JSON.stringify(outcome.detail)}`
      )
    );
  }

  results.push(
    check(
      "[ChartC1] Evidence由来のTable(数値列なし) -> Chartはblocks=null(Repository Evidence: " +
        "confidenceはlow/medium/highのカテゴリ値であり数値列が存在しないため)",
      (() => {

        const withEvidence: ArtifactBlock[] = [
          createEvidenceBlock({ claim: "主張1", source: "src1", confidence: "high" }, 0),
        ];

        // Phase82-A修正: comparisonがEvidence Tableへフォールバック
        // しなくなったため、この確認(Evidence Table→Chart拒否)は
        // 明示的にEvidence Table意図の入力を使う(既存Evidence Table
        // 経路自体は無変更)。
        const tableOutcome = buildBlocksForMutationKind("table", "根拠を表にして", normalPlan(), withEvidence);

        if (tableOutcome.blocks === null) {
          return false;
        }

        const chartOutcome = buildBlocksForMutationKind(
          "chart",
          "グラフにして",
          normalPlan(),
          tableOutcome.blocks
        );

        return (
          chartOutcome.blocks === null && chartOutcome.detail.chartStatus === "insufficient_data"
        );

      })()
    )
  );

  {
    // 数値列を持つTable Block(手動構成、Research経路以外からTable自体が
    // 既に存在するケースを想定)からはChartが作れることを確認する
    // (Phase76のbuildChartFromTable()自体は変更していないことの回帰確認)。
    const numericTable: TableBlock = {
      id: "t1",
      type: "table",
      columns: ["イベント名", "参加者数"],
      rows: [["イベントA", "120"], ["イベントB", "80"]],
      order: 0,
      createdAt: "x",
      updatedAt: "x",
    };

    const outcome = buildBlocksForMutationKind("chart", "グラフにして", normalPlan(), [numericTable]);

    results.push(
      check(
        "[ChartC2] 数値列を持つTableが既にある -> Chart Blockが生成される(created)",
        outcome.blocks !== null &&
          outcome.blocks.some((b) => b.type === "chart") &&
          outcome.detail.chartStatus === "created"
      )
    );
  }

  {
    // Phase82-A修正: TableC2と同じ理由で、no-op(再更新で新しい行が
    // 無い場合に拒否する)確認も構造化(fields付き)Exampleを使う形へ
    // 更新する。Comparison Tableの再更新no-op判定自体は
    // buildTableOutcomeForUserInput()内の既存ロジック(built.rows.length
    // <= existingComparisonTable.rows.lengthならinsufficient_data)で、
    // Phase82-Aでは変更していない。
    const structuredExample: ArtifactBlock[] = [
      createExampleBlock(
        "詳細: 事例Aの説明",
        0,
        "事例A",
        [{ label: "詳細", value: "事例Aの説明" }]
      ),
    ];

    const tableOutcome = buildBlocksForMutationKind("table", "表にして", normalPlan(), structuredExample);
    const table = tableOutcome.blocks!.find((b) => b.type === "table")!;

    // 同じExample集合のまま再度「表にして」-> 追加できる新しい行が無いためno-op(拒否)。
    const secondOutcome = buildBlocksForMutationKind(
      "table",
      "表にして",
      normalPlan(),
      tableOutcome.blocks!
    );

    results.push(
      check(
        "[TableC3] 新しいExampleが増えていない状態で再度「表にして」 -> no-op(blocks=null)",
        secondOutcome.blocks === null &&
          secondOutcome.detail.tableStatus === "insufficient_data" &&
          secondOutcome.detail.tablePurpose === "comparison",
        `table=${JSON.stringify(table)}, detail=${JSON.stringify(secondOutcome.detail)}`
      )
    );
  }

  {
    // Research: keyFindings=[]でもfindingCountは1(answerからのfallback)として報告される。
    const outcome = buildBlocksForMutationKind(
      "research",
      "中京大学について調査して",
      normalPlan({ answer: "調査結果本文", keyFindings: [], evidence: [] }),
      []
    );

    results.push(
      check(
        "[ResearchC1] keyFindings=[]でもfindingCount=1として報告される(実際にFinding Blockが1件生成される)",
        outcome.detail.findingCount === 1 &&
          outcome.blocks !== null &&
          outcome.blocks.filter((b) => b.type === "finding").length === 1
      )
    );
  }

  // ==========================================================
  // 77-E: Artifact Reference Question
  // ==========================================================

  results.push(
    check(
      "[RefE1] 「今の調査で一番重要なのは?」-> isArtifactReferenceQuestion=true",
      isArtifactReferenceQuestion("今の調査で一番重要なのは?")
    )
  );

  results.push(
    check(
      "[RefE2] 「ありがとう」-> isArtifactReferenceQuestion=false(雑談を誤検出しない)",
      !isArtifactReferenceQuestion("ありがとう")
    )
  );

  results.push(
    check(
      "[RefE3] 「事例を追加して」(Mutation指示) -> isArtifactReferenceQuestion=false",
      !isArtifactReferenceQuestion("事例を追加して")
    )
  );

  // Phase77再実装 Section10で追加された参照質問パターン。
  for (const [label, input] of [
    ["RefE3-a", "この調査から何が言える?"],
    ["RefE3-b", "どの施策を優先すべき?"],
    ["RefE3-c", "結局何が分かった?"],
    ["RefE3-d", "この調査の結論は?"],
  ] as const) {

    results.push(
      check(
        `[${label}] 「${input}」-> isArtifactReferenceQuestion=true`,
        isArtifactReferenceQuestion(input)
      )
    );

  }

  {
    const artifact: Artifact = {
      id: "art-1",
      userId: "user-1",
      title: "愛知県の大学生のスポーツイベント",
      blocks: [
        createFindingBlock("情報不足が参加の障壁になっている", 0),
        createFindingBlock("参加のきっかけ不足も障壁である", 1),
        createEvidenceBlock(
          { claim: "アンケートで62%が情報不足を理由に挙げた", source: "https://example.com", confidence: "high" },
          2
        ),
      ],
      content: "",
      version: 2,
      createdAt: "x",
      updatedAt: "x",
    };

    const answer = buildArtifactReferenceAnswer(artifact);

    results.push(
      check(
        "[RefE4] Finding/Evidenceを含むArtifact -> 実際のFinding本文を引用した回答が生成される(一般論ではない)",
        answer !== null &&
          answer.includes("情報不足が参加の障壁になっている") &&
          answer.includes("62%"),
        `answer=${JSON.stringify(answer)}`
      )
    );

  }

  {
    const emptyArtifact: Artifact = {
      id: "art-2",
      userId: "user-1",
      title: "無題",
      blocks: [],
      content: "",
      version: 1,
      createdAt: "x",
      updatedAt: "x",
    };

    results.push(
      check(
        "[RefE5] Finding/Evidence/Recommendationが1件も無いArtifact -> null(安全側フォールバック)",
        buildArtifactReferenceAnswer(emptyArtifact) === null
      )
    );

  }

  // ==========================================================
  // 77-F回帰: 既存Blockが消えない(既存Blockを土台にした更新)
  // ==========================================================

  {
    const existing: ArtifactBlock[] = [
      createFindingBlock("既存の発見", 0),
      createEvidenceBlock({ claim: "既存の根拠" }, 1),
    ];

    const blocks = buildResearchMutationBlocks(
      "追加調査して",
      "新しい調査結果",
      ["新しい発見"],
      [{ id: "e2", claim: "新しい根拠", confidence: "medium" }],
      existing
    );

    // +3 = ResearchSummary(常に1件) + Finding("新しい発見") + Evidence("新しい根拠")。
    results.push(
      check(
        "[UpdateF1] 既存Findingを渡した場合、既存Blockが消えずに新規Blockが追記される",
        blocks.length === existing.length + 3 &&
          blocks.some((b) => b.type === "finding" && (b as { content: string }).content === "既存の発見") &&
          blocks.some((b) => b.type === "finding" && (b as { content: string }).content === "新しい発見"),
        `types=${blocks.map((b) => b.type).join(",")}`
      )
    );

  }

  return summarize("tact-artifact UX / semantic update refinement (Phase 77)", results);

}
