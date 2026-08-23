// =========================
// detectAmbiguity (Phase 15)
// =========================
//
// 目的: 「実行可能性が低いほど何でも質問する」のではなく、「対象が
// 完全に不明で、結果品質が確実に損なわれる場合だけ」実行前に停止する
// ための最小限の安全弁(絶対条件: 保守的、質問しすぎない)。
//
// 絶対条件2: LLMを使わない。決定論的なルールのみで判定する
// (core/tact-intent/ruleRouter.tsのclassifyIntent()・
// core/tact-orchestrator/decomposer.tsの既存パターンと同じ、正規表現
// ベースの既存方針を踏襲する)。
//
// 絶対条件5(False Positive最優先): 「について/を」の直前に何らかの
// 具体的な語(固有名詞・一般名詞問わず)があれば、それがどんな語であれ
// 曖昧とは判定しない。曖昧と判定するのは、
//   (a) 対象語が一切存在しない裸の動詞(「調べて」「比較して」等)
//   (b) 対象語はあるが、それ自体が「先行文脈が無いと意味を成さない
//       カテゴリ語」である場合(「競合について」「資料を」等——
//       「競合」も「資料」も、それ単体では「何の競合か」「何のため
//       の資料か」が原理的に定まらない)
// の2パターンのみ。この2パターン以外は、どれだけ短い・一般的な語
// (「トヨタ」「生成AI」等)であっても曖昧とは判定しない。

export interface AmbiguityResult {

  ambiguous: boolean;

  // ambiguous===trueの場合のみ意味を持つ。1つだけの短い質問。
  question?: string;

}

// (a) 裸の動詞: 主語・目的語が一切存在しない依頼。完全一致のみを
// 対象とする(部分一致にすると「STEP210について調べて」のような
// 正当な依頼の末尾と誤って重なるリスクがあるため、絶対条件5により
// 完全一致という最も保守的な判定方法を選ぶ)。
const BARE_VERB_QUESTIONS: ReadonlyMap<string, string> = new Map([
  ["調べて", "何について調べればいいですか?"],
  ["調べてください", "何について調べればいいですか?"],
  ["調べてほしい", "何について調べればいいですか?"],
  ["調査して", "何について調査すればいいですか?"],
  ["調査してください", "何について調査すればいいですか?"],
  ["リサーチして", "何についてリサーチすればいいですか?"],
  ["リサーチしてください", "何についてリサーチすればいいですか?"],
  ["比較して", "何と何を比較すればいいですか?"],
  ["比較してください", "何と何を比較すればいいですか?"],
  ["教えて", "何について知りたいですか?"],
  ["教えてください", "何について知りたいですか?"],
  ["まとめて", "何についてまとめればいいですか?"],
  ["まとめてください", "何についてまとめればいいですか?"],
]);

// (b) 先行文脈が無いと意味を成さないカテゴリ語。絶対条件5に基づき
// 最小限のみ列挙する(Phase 14 Reality Testで実際に確認された2語の
// みを対象とし、将来使うかもしれない語を先回りで追加しない)。
const VAGUE_SUBJECT_QUESTIONS: ReadonlyMap<string, string> = new Map([
  ["競合", "どの競合について調べればいいですか?"],
  ["資料", "どんな資料を作りたいですか?"],
]);

// 「について|を」の直前までを主語として取り出す。「の」は境界に
// 含めない(「日本のスポーツ市場について」のような、主語自体に「の」を
// 含む正当な表現を誤って途中で区切らないため。core/tact-orchestrator/
// taskContext.tsのCJK境界処理とは別の目的の、独立した最小限の抽出)。
const SUBJECT_PATTERN = /^(.*?)(について|を)/;

export function detectAmbiguity(input: string): AmbiguityResult {

  const trimmed = input.trim();

  const bareVerbQuestion = BARE_VERB_QUESTIONS.get(trimmed);

  if (bareVerbQuestion) {

    return { ambiguous: true, question: bareVerbQuestion };

  }

  const match = trimmed.match(SUBJECT_PATTERN);

  if (match) {

    const subject = match[1].trim();

    if (!subject) {

      // 「について/を」の直前が空(例:「について調べて」のような
      // 先頭欠落)。これも対象語が無い裸の依頼として扱う。
      return {
        ambiguous: true,
        question: "何について調べればいいですか?",
      };

    }

    const vagueQuestion = VAGUE_SUBJECT_QUESTIONS.get(subject);

    if (vagueQuestion) {

      return { ambiguous: true, question: vagueQuestion };

    }

  }

  return { ambiguous: false };

}
