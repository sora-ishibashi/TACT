// =========================
// requirementDecomposition (STEP185)
// =========================
//
// Knowledge Gap Detectionの前段。ユーザーのqueryを「情報要求単位
// (Requirement)」へ分解する。
//
// 重要(STEP185絶対条件): LLMによる自然言語分解は行わない。
// 固定的・決定論的な正規表現パターンだけで、明確に安全と判断できる
// 場合のみ分解する。分解できない場合は必ずquery全体を1つの
// Requirementとして扱う(安全側に倒す)。
//
// 対応するパターン(STEP185で例示された範囲に限定し、いきなり
// 巨大な自然言語理解を目指さない):
//   1. 「Xの概要と特徴を教えて」  … 共有主語+並列属性
//   2. 「A、B、Cを教えて」       … 読点区切りのリスト
//   3. 「AとBを教えて」          … 単純な並列
//   4. 「Aについて、Bも教えて」  … 追加言及
//   5. 「AおよびBを教えて」      … 「および」による並列
//   6. 「AとBを比較」            … 比較要求

type DecompositionRule = (query: string) => string[] | null;

const TRAILING_PREDICATE =
  "(教えて|整理して|まとめて|知りたい|説明して)";

// STEP194: 「を」と述語(TRAILING_PREDICATE)の間に「簡潔に」「詳しく」
// のような副詞句が入る自然な言い回し(例:「AとBを簡潔に整理して
// ください」)に対応するための、限定的な語彙リスト。STEP185時点の
// 実装は「を」の直後に述語が直接隣接することを前提としていたため、
// この間に副詞句が入ると全ての分解ルールが不一致になり、query全体が
// 安全側フォールバックで単一Requirementとして扱われていた
// (STEP192/193監査で発見)。
//
// 巨大な語彙リストへ拡張しない(STEP194絶対条件)。実際に頻出する
// 語彙のみに限定する。一致しない副詞句は従来どおり安全側
// フォールバック(単一Requirement)のままになる。
const OPTIONAL_ADVERB =
  "(?:簡潔に|詳しく|具体的に|わかりやすく|簡単に)?";

// 1. 「Xの概要と特徴を教えて」のような、共有主語+並列属性。
// 他のパターンより先に試す(「AとBを教えて」パターンにも一致して
// しまい、共有主語を失った状態(例: "Xの概要"と"特徴"のみ)で
// 分解されることを避けるため)。
const sharedSubjectRule: DecompositionRule = (query) => {

  // STEP194: 述語の直前の助詞を「を」に固定せず、「について」も
  // 許容する(例:「Xの売上高と主要事業について簡潔に説明して
  // ください」)。「を」「について」いずれの場合も、その直後に
  // OPTIONAL_ADVERBの副詞句が任意で入ってよい。
  const match = query.match(
    new RegExp(`^(.+?)の(.+?)と(.+?)(?:を|について)${OPTIONAL_ADVERB}${TRAILING_PREDICATE}`)
  );

  if (!match) return null;

  const [, subject, aspect1, aspect2] = match;

  if (!subject.trim() || !aspect1.trim() || !aspect2.trim()) return null;

  // STEP185監査で発見: aspect2自身が「の」を含む場合(例:
  // 「A社の主要事業と他社Xの離職率を教えて」)、aspect2は既に
  // 自分自身の主語を持っている(=共有主語ではない)。この場合に
  // 無理にsubjectを前置すると「A社の他社Xの離職率」という
  // 意味の壊れたRequirementを作ってしまうため、このルールでは
  // 分解せずnullを返し、より一般的なsimpleAndRule
  // (「AとBを教えて」)へ委ねる(そちらはsubjectを前置しないため
  // 正しく分解できる)。
  if (aspect2.includes("の")) return null;

  return [
    `${subject.trim()}の${aspect1.trim()}`,
    `${subject.trim()}の${aspect2.trim()}`,
  ];

};

// 2. 「A、B、Cを教えて」のような、読点区切りのリスト。
const commaListRule: DecompositionRule = (query) => {

  const match = query.match(
    new RegExp(`^(.+?)を${TRAILING_PREDICATE}$`)
  );

  if (!match) return null;

  const subject = match[1];

  if (!subject.includes("、")) return null;

  const parts = subject
    .split("、")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  return parts;

};

// 3. 「AとBを教えて」のような、単純な並列。
const simpleAndRule: DecompositionRule = (query) => {

  // STEP194: 「を」と述語の間にOPTIONAL_ADVERBの副詞句が任意で
  // 入ってよいようにする(例:「AとBを詳しく教えて」)。
  const match = query.match(
    new RegExp(`^(.+?)と(.+?)を${OPTIONAL_ADVERB}${TRAILING_PREDICATE}`)
  );

  if (!match) return null;

  const [, a, b] = match;

  if (!a.trim() || !b.trim()) return null;

  // STEP199: bが「の関係」「の違い」で終わる場合、「AとBの関係/違い」は
  // AとBを比較・関連付ける1つの意味単位であり、「A」と「Bの関係/違い」
  // という無関係な2つのRequirementへ分割すべきではない(STEP194で
  // 発見・保留、STEP199で修正)。sharedSubjectRuleの既存ガード
  // (aspect2.includes("の")、STEP185)と同じ「安全側にしか倒さない」
  // 方針を踏襲するが、範囲はこの2語のみに限定する(「他社Xの離職率」
  // のような、bが独立した主語+属性を表す一般的なケースまで抑制しない
  // ため、aspect2.includes("の")という広いガードは使わない)。
  if (/(の関係|の違い)$/.test(b.trim())) return null;

  return [a.trim(), b.trim()];

};

// 4. 「Aについて、Bも教えて」のような、追加言及。
const additionalMentionRule: DecompositionRule = (query) => {

  const match = query.match(
    new RegExp(`^(.+?)について、?\\s*(.+?)も${TRAILING_PREDICATE}`)
  );

  if (!match) return null;

  const [, a, b] = match;

  if (!a.trim() || !b.trim()) return null;

  return [a.trim(), b.trim()];

};

// 5. 「AおよびBを教えて」のような、「および」による並列。
const andAlsoRule: DecompositionRule = (query) => {

  const match = query.match(
    new RegExp(`^(.+?)および(.+?)を${TRAILING_PREDICATE}`)
  );

  if (!match) return null;

  const [, a, b] = match;

  if (!a.trim() || !b.trim()) return null;

  return [a.trim(), b.trim()];

};

// 6. 「AとBを比較」のような、比較要求。
const compareRule: DecompositionRule = (query) => {

  const match = query.match(/^(.+?)と(.+?)を比較/);

  if (!match) return null;

  const [, a, b] = match;

  if (!a.trim() || !b.trim()) return null;

  return [a.trim(), b.trim()];

};

// 上から順に試し、最初に一致したルールの結果を採用する
// (共有主語パターンを最優先に、より一般的なパターンへ)。
const DECOMPOSITION_RULES: DecompositionRule[] = [
  sharedSubjectRule,
  commaListRule,
  simpleAndRule,
  additionalMentionRule,
  andAlsoRule,
  compareRule,
];

export function decomposeIntoRequirements(
  query: string
): string[] {

  for (const rule of DECOMPOSITION_RULES) {

    const result = rule(query);

    if (result && result.length >= 2) {
      return result;
    }

  }

  // どのルールにも一致しない場合、query全体を1つのRequirementとして
  // 扱う(安全側)。
  return [query];

}
