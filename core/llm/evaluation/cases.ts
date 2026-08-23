// =========================
// Sample Evaluation Cases (STEP170)
// =========================
//
// STEP170の目的は「評価ケースを定義できる仕組みを作ること」であり、
// 大量のベンチマークケースを用意することではない。ここでは、
// EvaluationTaskCategoryの6分類それぞれについて、型が正しく機能する
// ことを示す代表例を1件ずつ用意するだけに留める。
//
// これらのケースはSTEP170では自動実行されない
// (runEvaluationSuite()を呼び出すのは利用者側の責務)。

import { EvaluationCase } from "./types";

export const SAMPLE_EVALUATION_CASES: EvaluationCase[] = [

  // A. Simple — 単純な指示・変換
  {
    id: "simple-001",
    category: "simple",
    systemPrompt: "あなたは要約AIです。指示に厳密に従ってください。",
    userPrompt:
      "以下の文章を100文字以内で要約してください。\n\n" +
      "生成AIは、大量のデータから学習したパターンをもとに、新しい" +
      "文章・画像・音声・動画などのコンテンツを生成できる技術です。" +
      "従来のAIが分類や予測を主な用途としていたのに対し、生成AIは" +
      "創造的な出力そのものを目的とする点が特徴です。",
  },

  // B. Writing — 文章生成
  {
    id: "writing-001",
    category: "writing",
    systemPrompt: "あなたはビジネス文書のライターです。",
    userPrompt:
      "大学のゼミ活動について、企業向けに説明する文章を作成して" +
      "ください。",
  },

  // C. Research — 調査・整理
  {
    id: "research-001",
    category: "research",
    systemPrompt: "あなたはリサーチャーです。",
    userPrompt:
      "生成AIが企業活動に与える影響について、主要な論点を整理して" +
      "ください。",
  },

  // D. Reasoning — 複数条件からの結論導出
  {
    id: "reasoning-001",
    category: "reasoning",
    systemPrompt: "あなたは論理的思考AIです。与えられた前提だけから" +
      "確実に言えることのみを述べ、推測を加えないでください。",
    userPrompt:
      "以下の前提から、確実に言えることを述べてください。\n\n" +
      "・A社の売上はB社より多い。\n" +
      "・B社の従業員数はC社より多い。\n" +
      "・C社の利益率はA社より高い。",
  },

  // E. Structured Output — 構造化出力
  {
    id: "structured-output-001",
    category: "structured-output",
    systemPrompt: "必ずJSONのみで返してください。説明文やMarkdown" +
      "コードフェンスは含めないでください。",
    userPrompt:
      '{"name": string, "age": number, "occupation": string} ' +
      "という形式で、架空の人物情報を1件作成してください。",
    responseFormat: "json",
  },

  // F. Long Context — 長文処理
  {
    id: "long-context-001",
    category: "long-context",
    systemPrompt: "あなたは要約AIです。",
    userPrompt:
      "以下の長文を読み、主要なポイントを3つ挙げてください。\n\n" +
      // STEP170: 実際のベンチマークは対象外のため、繰り返しによる
      // 疑似的な長文で「長文入力を扱える設計になっているか」だけを
      // 示す(内容の妥当性は評価しない)。
      "生成AIの企業導入に関する論点。".repeat(50),
  },

];
