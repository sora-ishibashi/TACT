// =========================
// TACT parseComparisonColumns() 後続文対応 Regression (Phase 91)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.tsのparseComparisonColumns()
// (比較トリガーを含む文自体には列挙が無く、直後の文で初めて列が
// 列挙される言い回しへの対応)。
//
// Root Cause(Phase90 Reality Test): 「ここまで調べたイベントを、参加
// しやすさを比較できる表にしてください。列は以下の6項目で整理して
// ください。イベント名、開催日、参加費、対象学年、開催形式、定員。」
// という実際の言い回しで、parseComparisonColumns()がundefinedを返し、
// buildResearchTableSchema()もundefinedとなり、Table-aware Research
// Promptが一度も発火しなかった(実DBで確認済み)。
//
// 環境制約(Phase66〜90と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数のみ。
//
// 責務境界: 本Phaseで変更するのはparseComparisonColumns()のみ。
// classifyTablePurpose()・hasTableIntent()・parseRequestedRowCount()の
// 判定ロジックには一切手を入れない(それぞれの既存回帰テストが
// tactArtifactPhase79/85.test.tsに存在し、本Phaseでは変更しない)。

import "dotenv/config";
import {
  parseComparisonColumns,
  parseRequestedRowCount,
  classifyTablePurpose,
  hasTableIntent,
  buildResearchTableSchema,
} from "../../../core/tact-conversation/artifactMutation";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Case A: 比較要求 -> 後続文 -> 列指定(Phase90 Reality Testの
  // Turn3実文面をそのままfixtureとして使用)
  // ==========================================================

  {
    const turn3Input =
      "ここまで調べたイベントを、参加しやすさを比較できる表にしてください。" +
      "列は以下の6項目で整理してください。" +
      "イベント名、開催日、参加費、対象学年、開催形式、定員。" +
      "各セルの情報が、どのEvidenceを根拠にしているのか追跡できる状態にしてください。" +
      "確認できない情報は推測せず「情報未確認」としてください。" +
      "横に長くなっても構いませんので、6項目すべてを保持してください。";

    const columns = parseComparisonColumns(turn3Input);

    results.push(
      check(
        "[CaseA-1] 比較トリガー文と列指定文が分かれていても、直後の文から列を抽出する",
        JSON.stringify(columns) ===
          JSON.stringify(["イベント名", "開催日", "参加費", "対象学年", "開催形式", "定員"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

    results.push(
      check(
        "[CaseA-2] classifyTablePurpose()は引き続き'comparison'(Phase85/89修正への回帰なし)",
        classifyTablePurpose(turn3Input) === "comparison"
      )
    );

    results.push(
      check(
        "[CaseA-3] hasTableIntent()は引き続きtrue(「表にして」を含む)",
        hasTableIntent(turn3Input) === true
      )
    );

    const schema = buildResearchTableSchema(turn3Input);

    results.push(
      check(
        "[CaseA-4] buildResearchTableSchema()が実Reality TestのTurn3文面で正しくSchemaを返す" +
          "(Phase90で発火しなかったTable-aware Research Promptの直接原因の修正確認)",
        schema !== undefined &&
          JSON.stringify(schema.columns) ===
            JSON.stringify(["イベント名", "開催日", "参加費", "対象学年", "開催形式", "定員"]),
        `schema=${JSON.stringify(schema)}`
      )
    );

    results.push(
      check(
        "[CaseA-5] requestedRowCountはこの文面に件数指定が無いためundefined(架空の件数を作らない)",
        buildResearchTableSchema(turn3Input)?.requestedRowCount === undefined
      )
    );

  }

  // ==========================================================
  // Case B: 既存の「比較要求より前(同一文内)に列が存在する」パターン
  // (Phase79 TestB-2/TestB-4の回帰確認 — 本Phaseで壊していないことの
  // 再確認のため、本ファイルでも独立に検証する)
  // ==========================================================

  {
    const input = "愛知県内のイベントを5件、イベント名・地域・対象者・特徴で比較表にして";
    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[CaseB-1] 比較要求より前・同一文内の列指定は従来通り抽出される",
        JSON.stringify(columns) === JSON.stringify(["イベント名", "地域", "対象者", "特徴"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

    results.push(
      check(
        "[CaseB-2] parseRequestedRowCount()も従来通り「5件」を抽出する",
        parseRequestedRowCount(input) === 5
      )
    );

  }

  {
    const input =
      "ここまで整理したイベント事例を、イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較表にして";
    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[CaseB-3] 「Xの5項目で」形式・無関係な先行節混入なしも従来通り",
        JSON.stringify(columns) ===
          JSON.stringify(["イベント名", "地域", "対象者", "特徴", "参加しやすい理由"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  // ==========================================================
  // Case C: 比較要求と列指定が同一文にあるパターン(直後の文への
  // fallbackを追加した後も、同一文内で見つかれば直後の文は見ない
  // ことの確認)
  // ==========================================================

  {
    const input = "イベント名・開催日・参加費で比較して表にまとめてください。";
    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[CaseC-1] 比較要求と列指定が同一文にある場合は、直後の文を見るまでもなく同一文から抽出される",
        JSON.stringify(columns) === JSON.stringify(["イベント名", "開催日", "参加費"]),
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  // ==========================================================
  // Case D: 列指定が存在しない場合(同一文にも直後の文にも列挙が
  // 無い・そもそも直後の文が存在しない) -> undefinedのまま
  // ==========================================================

  results.push(
    check(
      "[CaseD-1] 単一語(列挙ではない)の「重要度で整理して」-> undefined(直後の文が無い、Phase79 TestB-5の回帰確認)",
      parseComparisonColumns("重要度で整理して") === undefined
    )
  );

  {
    const input = "イベントを比較できる表にしてください。詳細は追ってお知らせします。";
    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[CaseD-2] 直後の文はあるが列挙(・、,)を含まない場合はundefined(無関係な文を列として誤抽出しない)",
        columns === undefined,
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  {
    const input = "イベントを比較できる表にしてください。";
    const columns = parseComparisonColumns(input);

    results.push(
      check(
        "[CaseD-3] トリガー文の後に文が存在しない(直後の「。」が無い)場合もundefined",
        columns === undefined,
        `columns=${JSON.stringify(columns)}`
      )
    );

  }

  return summarize("parseComparisonColumns-next-sentence-fix (Phase 91)", results);

}
