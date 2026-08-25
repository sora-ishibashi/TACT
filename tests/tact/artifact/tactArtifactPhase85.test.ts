// =========================
// TACT 節スコープ誤判定修正 Regression (Phase 85)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.tsのclassifyTablePurpose()
// (Comparison/Evidence Table判定の優先順位修正)、
// core/tact-conversation/artifactReference.tsのisArtifactReferenceQuestion()
// (新規調査要求との誤判定防止)。
//
// 環境制約(Phase66〜84と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数のみ。

import "dotenv/config";
import {
  classifyTablePurpose,
  classifyArtifactMutation,
} from "../../../core/tact-conversation/artifactMutation";
import { isArtifactReferenceQuestion } from "../../../core/tact-conversation/artifactReference";
import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import {
  buildResearchOutcomeWithOptionalTable,
  buildBlocksForMutationKind,
  type ConversationOrchestrationPlan,
} from "../../../core/tact-conversation/orchestration";
import type { TableBlock } from "../../../core/tact-artifact/types";
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // classifyTablePurpose(): Phase85必須テスト1〜5
  // ==========================================================

  results.push(
    check(
      "[TablePurpose-1] 「イベントを比較表にしてください。根拠も追跡できるようにしてください。」-> comparison",
      classifyTablePurpose("イベントを比較表にしてください。根拠も追跡できるようにしてください。") === "comparison"
    )
  );

  results.push(
    check(
      "[TablePurpose-2] 「イベントを比較して、出典も付けてください。」-> comparison",
      classifyTablePurpose("イベントを比較して、出典も付けてください。") === "comparison"
    )
  );

  results.push(
    check(
      "[TablePurpose-3] 「Evidenceを根拠・出典・確信度で表にしてください。」-> evidence",
      classifyTablePurpose("Evidenceを根拠・出典・確信度で表にしてください。") === "evidence"
    )
  );

  results.push(
    check(
      "[TablePurpose-4] 「根拠となるEvidenceを表にしてください。」-> evidence",
      classifyTablePurpose("根拠となるEvidenceを表にしてください。") === "evidence"
    )
  );

  // Phase79/81/82/83で既にcomparisonとして扱われていた代表的な入力が
  // Phase85修正後も維持されることを確認する(既存挙動の回帰確認)。
  const preservedComparisonInputs = [
    "愛知県内のイベントを5件、イベント名・地域・対象者・特徴で比較表にして",
    "表にして",
    "ここまで整理したイベント事例を、イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較表にして。",
  ];

  results.push(
    check(
      "[TablePurpose-5] Phase79/82で既にcomparisonだった入力は修正後もcomparisonのまま",
      preservedComparisonInputs.every((input) => classifyTablePurpose(input) === "comparison"),
      `results=${JSON.stringify(preservedComparisonInputs.map((i) => [i, classifyTablePurpose(i)]))}`
    )
  );

  results.push(
    check(
      "[TablePurpose-6] 「根拠を表にして」「出典を一覧にして」は修正後もevidenceのまま(既存Evidence Tableケース維持)",
      classifyTablePurpose("根拠を表にして") === "evidence" &&
        classifyTablePurpose("出典を一覧にして") === "evidence"
    )
  );

  // ==========================================================
  // isArtifactReferenceQuestion(): Phase85必須テスト1〜6
  // ==========================================================

  results.push(
    check(
      "[RefQ-1] 「前の調査結果の中で、どれを優先すべきですか？」-> true",
      isArtifactReferenceQuestion("前の調査結果の中で、どれを優先すべきですか？")
    )
  );

  results.push(
    check(
      "[RefQ-2] 「さっきの結果の中でおすすめはどれですか？」-> true",
      isArtifactReferenceQuestion("さっきの結果の中でおすすめはどれですか？")
    )
  );

  results.push(
    check(
      "[RefQ-3] 「5件ほど追加で確認してください。確認できるものを優先してください。」-> false",
      !isArtifactReferenceQuestion("5件ほど追加で確認してください。確認できるものを優先してください。")
    )
  );

  results.push(
    check(
      "[RefQ-4] 「前の調査結果を踏まえて、追加で5件調べてください。」-> false",
      !isArtifactReferenceQuestion("前の調査結果を踏まえて、追加で5件調べてください。")
    )
  );

  results.push(
    check(
      "[RefQ-5] 「前に調べた内容からおすすめを教えてください。」-> true",
      isArtifactReferenceQuestion("前に調べた内容からおすすめを教えてください。")
    )
  );

  // Phase77 RefE1・RefE3-a〜dの代表ケースが修正後も維持されることを
  // 確認する(このファイル自身でも直接再検証し、artifactReference.ts
  // 単体の回帰確認を完結させる)。
  const preservedTrueInputs = [
    "今の調査で一番重要なのは?",
    "この調査から何が言える?",
    "どの施策を優先すべき?",
    "結局何が分かった?",
    "この調査の結論は?",
  ];

  results.push(
    check(
      "[RefQ-6] Phase77で確立された既存trueケース(RefE1・RefE3-a〜d)は修正後も全てtrueのまま",
      preservedTrueInputs.every((input) => isArtifactReferenceQuestion(input)),
      `results=${JSON.stringify(preservedTrueInputs.map((i) => [i, isArtifactReferenceQuestion(i)]))}`
    )
  );

  results.push(
    check(
      "[RefQ-7] Phase77で確立された既存falseケース(「ありがとう」「事例を追加して」)は修正後もfalseのまま",
      !isArtifactReferenceQuestion("ありがとう") && !isArtifactReferenceQuestion("事例を追加して")
    )
  );

  // ==========================================================
  // 最重要Regression Scenario(Section5): Phase83で失敗した3ターン
  // 会話を、実際のclassifyIntent()/classifyArtifactMutation()/
  // isArtifactReferenceQuestion()の組み合わせで再現する。
  // ==========================================================

  const turn1Input =
    "愛知県内で、大学生が参加しやすいスポーツイベントについて調査してください。具体的なイベントを中心に調べてください。";
  const turn2Input =
    "大学3〜4年生が実際に参加しやすそうなものを5件ほど追加で確認してください。確認できるものを優先してください。";
  const turn3Input =
    "ここまで確認したイベントを、イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較表にしてください。各行がどのEvidenceを根拠にしているのか追跡できる状態にしてください。";

  {

    // ---- Turn1: 実Research(実際のclassifyIntent()経由) ----
    const turn1Decision = classifyIntent(turn1Input);

    results.push(
      check(
        "[Scenario-Turn1] classifyIntent()がTurn1を'research'と判定する(既存挙動、回帰なし)",
        turn1Decision.intent === "research"
      )
    );

    const turn1Plan = normalPlan({
      capability: "research",
      answer:
        "愛知県内で現在または今後参加できる大学生向けのスポーツイベントには、以下のものがあります。" +
        "2026年に愛知・名古屋で開催予定の「なごやeスポーツチャレンジ」はeスポーツに注目したイベントです。",
      keyFindings: [
        "2026年に愛知・名古屋で開催の「なごやeスポーツチャレンジ」に参加可能",
        "愛知県スポーツポータルで市民参加型のスポーツ大会情報あり",
      ],
      evidence: [
        { id: "e1", claim: "スポーツイベント｜名古屋市公式ウェブサイト", source: "https://www.city.nagoya.jp/…", confidence: "high" },
        { id: "e2", claim: "愛知県のスポーツ情報ポータルサイト", source: "https://aichi-sports.jp/event/", confidence: "medium" },
      ],
    });

    const turn1Outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      turn1Input,
      turn1Plan,
      []
    );

    results.push(
      check(
        "[Scenario-Turn1-2] Turn1はResearch Block(Finding/Evidence)を正しく生成する",
        turn1Outcome.blocks !== null &&
          turn1Outcome.blocks.some((b) => b.type === "finding") &&
          turn1Outcome.blocks.some((b) => b.type === "evidence")
      )
    );

    // ---- Turn2: 実際のclassifyIntent()/classifyArtifactMutation()/
    // isArtifactReferenceQuestion()の組み合わせをそのまま検証する ----
    const turn2Decision = classifyIntent(turn2Input);
    const turn2Capability = turn2Decision.intent === "research" ? "research" : "orchestrator";
    const turn2Kind = classifyArtifactMutation(turn2Input, turn2Capability);

    results.push(
      check(
        "[Scenario-Turn2-1] Phase85修正後、Turn2はArtifact Reference Questionに誤分類されない(Root Cause 1の直接検証)",
        !isArtifactReferenceQuestion(turn2Input)
      )
    );

    // Phase86更新: このcheckはPhase85時点で「Turn2がclassifyIntent()
    // 単体ではchatに分類され、新規Researchが実行されない」という
    // 既知の残存ギャップを記録していた(Phase85の対象は
    // classifyTablePurpose()・isArtifactReferenceQuestion()の2関数のみ
    // で、ruleRouter.ts側の判定は明示的にスコープ外だったため)。
    // Phase86でcore/tact-intent/ruleRouter.tsのclassifyIntent()に
    // 「追加で/さらに/他にも/別の」+調査系動詞という決定論的パターンを
    // 追加した結果、この文面(「…5件ほど追加で確認してください。」)は
    // 単独でもresearchと判定されるようになった——このcheckをPhase86の
    // 修正後の正しい期待値へ更新する(Phase85で「次Phaseへの申し送り」
    // としていた事項が、実際にPhase86で解消されたことの確認)。
    results.push(
      check(
        "[Scenario-Turn2-2][Phase86で解消] Turn2の文面は単独でもresearchと判定され、" +
          "kind='research'になる(Phase85で記録した残存ギャップがPhase86で解消された)",
        turn2Decision.intent === "research" && turn2Kind === "research",
        `turn2Decision=${JSON.stringify(turn2Decision)}, turn2Kind=${turn2Kind}`
      )
    );

    // ---- Turn3: classifyTablePurpose()の修正を直接検証する ----
    const turn3Decision = classifyIntent(turn3Input);
    const turn3Capability = turn3Decision.intent === "research" ? "research" : "orchestrator";
    const turn3Kind = classifyArtifactMutation(turn3Input, turn3Capability);
    const turn3TablePurpose = classifyTablePurpose(turn3Input);

    results.push(
      check(
        "[Scenario-Turn3-1] Turn3はkind='table'と判定される",
        turn3Kind === "table"
      )
    );

    results.push(
      check(
        "[Scenario-Turn3-2] Root Cause 2の直接検証: Evidence Traceability要求('根拠を追跡できる状態に')が" +
          "含まれていても、明示的な「比較表」要求が優先され、tablePurpose='comparison'になる" +
          "(Phase84で発生した'evidence'への誤分類が解消されている)",
        turn3TablePurpose === "comparison"
      )
    );

    // Turn2が新規Researchを実行しなかった(既知の残存ギャップ)ため、
    // Turn3の時点でRow Entity(fields付きExampleBlock)はTurn1由来の
    // ものしか存在しない。Turn1のanswerは地の文であり構造化データを
    // 含まないため、Row Entityは0件のまま——ここでPhase82-Aの
    // 「comparisonリクエストはEvidence Tableへフォールバックしない」
    // という絶対条件が正しく機能し、旧来の「事例|詳細」的な
    // Evidence Tableへのフォールバックが発生しないことを確認する
    // (Phase84で実際に発生した不具合の直接的な再発防止確認)。
    const turn3Outcome = buildBlocksForMutationKind(
      "table",
      turn3Input,
      normalPlan(),
      turn1Outcome.blocks ?? []
    );

    results.push(
      check(
        "[Scenario-Turn3-3] Row Entity不足時でも、tablePurpose='comparison'のままEvidence Tableへ" +
          "フォールバックせず、insufficient_dataとして正直に拒否する(架空データを作らない、Phase82-A維持)",
        turn3Outcome.blocks === null &&
          turn3Outcome.detail.tableStatus === "insufficient_data" &&
          turn3Outcome.detail.tablePurpose === "comparison",
        `detail=${JSON.stringify(turn3Outcome.detail)}`
      )
    );

  }

  // ==========================================================
  // Regression Scenario(拡張): Turn2が実際にResearch Capabilityへ
  // 到達した場合(将来classifyIntent()側が拡張された場合の想定、また
  // は既に「調査して」等を含む同義の言い回しだった場合)に、Phase85の
  // 2つの修正だけでパイプライン全体が正しく機能することを確認する。
  // (classifyIntent()自体は変更していないため、ここではTurn2の
  // capability="research"を直接与えて、Row Entity蓄積->Turn3の
  // Comparison Table生成までを検証する——Phase82のTestG/Hと同じ
  // 確立済みパターン。)
  // ==========================================================

  {

    const turn1Plan = normalPlan({
      capability: "research",
      answer: "愛知県内で大学生向けのスポーツイベントについて調査しました。",
      keyFindings: ["複数のスポーツイベントが確認できた"],
      evidence: [{ id: "e1", claim: "愛知県のスポーツイベント一覧", source: "https://example.com/events", confidence: "medium" }],
    });

    const turn1Outcome = await buildResearchOutcomeWithOptionalTable(undefined, turn1Input, turn1Plan, []);

    const turn2AnswerWithTable = `
| イベント名 | 地域 | 対象者 | 特徴 | 参加しやすい理由 |
|---|---|---|---|---|
| なごやeスポーツチャレンジ | 名古屋市 | 大学生 | eスポーツ大会 | オンライン参加も可能 |
| 愛知県民スポーツ大会 | 愛知県全域 | 一般・大学生 | 総合スポーツ大会 | 種目が豊富で参加しやすい |
`;

    const turn2Plan = normalPlan({
      capability: "research",
      answer: turn2AnswerWithTable,
      keyFindings: [],
      evidence: [
        {
          id: "e2",
          claim: "愛知県内大学生向けスポーツイベント詳細",
          source: "https://example.com/details",
          confidence: "high",
          snippet:
            "なごやeスポーツチャレンジは名古屋市で開催され、対象者は大学生、eスポーツ大会が特徴でオンライン参加も可能。" +
            "愛知県民スポーツ大会は愛知県全域で開催され、対象者は一般・大学生、総合スポーツ大会が特徴で種目が豊富で参加しやすい。",
        },
      ],
    });

    const turn2Outcome = await buildResearchOutcomeWithOptionalTable(
      undefined,
      turn2Input,
      turn2Plan,
      turn1Outcome.blocks ?? []
    );

    const structuredCount =
      turn2Outcome.blocks?.filter((b) => b.type === "example" && !!b.fields && b.fields.length > 0).length ?? 0;

    results.push(
      check(
        "[Scenario-Extended-1] Turn2がResearch Capabilityへ到達した場合、Row Entityが正しく蓄積される" +
          "(Phase82-Dの常時Row Entity抽出+Phase83のEvidence Groundingが機能する)",
        turn2Outcome.blocks !== null && structuredCount === 2,
        `structuredCount=${structuredCount}`
      )
    );

    const turn3Outcome = buildBlocksForMutationKind(
      "table",
      turn3Input,
      normalPlan(),
      turn2Outcome.blocks ?? []
    );

    const table = turn3Outcome.blocks?.find((b): b is TableBlock => b.type === "table");

    results.push(
      check(
        "[Scenario-Extended-2] Turn2でRow Entityが蓄積されていれば、Turn3でComparison Tableが" +
          "実際に生成される(tablePurpose='comparison'、Evidence Tableへのフォールバックなし)",
        turn3Outcome.blocks !== null &&
          table !== undefined &&
          table.tablePurpose === "comparison" &&
          table.rows.length === 2 &&
          table.rows.some((r) => r[0] === "なごやeスポーツチャレンジ"),
        `detail=${JSON.stringify(turn3Outcome.detail)}, table=${JSON.stringify(table)}`
      )
    );

    results.push(
      check(
        "[Scenario-Extended-3] Comparison TableのEvidence Traceability(rowSourceEvidenceIds)が維持される",
        table !== undefined &&
          table.rowSourceEvidenceIds !== undefined &&
          table.rowSourceEvidenceIds.every((ids) => ids.includes("e2")),
        `rowSourceEvidenceIds=${JSON.stringify(table?.rowSourceEvidenceIds)}`
      )
    );

  }

  return summarize("tact-clause-scope-classification-fix (Phase 85)", results);

}
