// =========================
// outputSpec (STEP51〜STEP52)
// =========================
//
// 背景: Writerの出力粒度(文字数・詳細度・スライド枚数など)が、
// core/prompt/outputFormats.tsとcore/agents/writer.tsの両方に
// 「十分なEvidenceがある場合は3000〜10000文字程度」という
// 固定的な想定として埋め込まれており、タスク・ユーザー指定に
// 応じて動的に調整できなかった。
//
// 本モジュールは、「どれくらいの粒度で成果物を作るか」を表す
// OutputSpecを、以下の優先順位で決定する。
//
//   1. ユーザーが明示した出力条件(「短く」「詳しく」
//      「2000文字程度」「1000文字以内」「2000〜3000文字」等)
//   2. artifactType × detailLevelから推定した既定値(STEP52)
//   3. TACTの既定(detailLevel: "standard"、文字数指定なし)
//
// 既存のrequestTypeGuard.ts/researchRequirement.tsと同じ方針で、
// 新しいLLM呼び出しは追加せず、最新のユーザー発言(userInput)に
// 対する軽量な正規表現パターンだけで検出する
// (巨大な自然言語Parserを新設しない)。
//
// STEP52: 「量の指定」だけだったOutputSpecに、各項目
// (executiveSummary/sections/keyFindings/recommendations/
// nextActions)への相対的な情報配分(allocation)を追加した。
// あわせて、mode(quick/think/deep)をdetailLevelへの補助的な
// 影響として組み込んだ(ユーザー明示 > artifactType既定 > mode、
// という優先順位は崩さない)。
//
// OutputSpec自体はcurrentOutput Schema(Writerが実際に書いたもの)
// とは別物であり、「どのくらい作るか」という生成前の指示にすぎない。
// 文字数を機械的にtruncateする後処理は行わない
// (buildOutputSpecGuidanceが組み立てるのは、あくまでWriterへの
// Prompt上の目安であり、絶対命令ではない)。

export type DetailLevel = "brief" | "standard" | "detailed" | "deep";

// STEP52: 各項目への相対的な情報配分レベル。絶対文字数ではなく、
// 「他の項目と比べてどれだけ重点を置くか」を表す。
export type AllocationLevel = "low" | "medium" | "high";

export interface OutputAllocation {
  executiveSummary: AllocationLevel;
  sections: AllocationLevel;
  keyFindings: AllocationLevel;
  recommendations: AllocationLevel;
  nextActions: AllocationLevel;
}

export interface OutputSpec {

  detailLevel: DetailLevel;

  // 全体の文字数の目安。ユーザーが明示した場合、またはartifactType
  // 既定値に設定がある場合のみ存在する。STEP52でminCharacters
  // (範囲指定「2000〜3000文字」等)にも対応した。
  lengthPreference?: {
    minCharacters?: number;
    maxCharacters?: number;
  };

  // Presentation(artifactType: "presentation")の場合のみ使う、
  // スライド枚数の目安。
  presentation?: {
    targetSlides?: number;
  };

  // STEP52で追加。各項目への相対的な配分。artifactType×detailLevel
  // から機械的に決定する(ユーザーが自然言語で「Key Findingsを
  // 厚めに」のように個別指定することは今回は扱わない。過剰な
  // Parserを避けるため)。
  allocation: OutputAllocation;

}

export type ArtifactTypeForOutputSpec =
  | "report"
  | "comparison"
  | "proposal"
  | "presentation";

export type ModeForOutputSpec = "quick" | "think" | "deep";

// =========================
// artifactType別デフォルト(detailLevel)
// =========================
//
// ユーザーが明示的な指定をしなかった場合にのみ使用する。
// 具体的な文字数の絶対指定はここでは持たせない
// (STEP51は「目安を伝えられる基盤」までが目的であり、
// artifactTypeだけで文字数を機械的に決め打ちしない)。

const ARTIFACT_TYPE_DEFAULT_DETAIL_LEVEL: Record<
  ArtifactTypeForOutputSpec,
  DetailLevel
> = {

  // Report: 事実・分析を中心に、必要十分な説明量(既存Writerの
  // 標準的な挙動をそのまま踏襲する)。
  report: "standard",

  // Comparison: 比較対象・比較軸を明確にすることを優先し、
  // 冗長な説明は避ける(既存のbuildArtifactStyleGuidanceの
  // comparison指示と矛盾しないよう、standardのままにする)。
  comparison: "standard",

  // Proposal: 意思決定に必要な情報(背景・課題・提案・根拠・実行方法)
  // を優先するため、標準よりやや詳細な水準を既定にする。
  proposal: "detailed",

  // Presentation: 文章量を減らし、スライドで視認できる情報量を
  // 優先する。既存のbuildArtifactStyleGuidanceが既に「簡潔な
  // 箇条書き」を指示しているため、detailLevelはstandardのまま、
  // スライド枚数の目安だけ別途持たせる。
  presentation: "standard",

};

// Presentationのみが使うスライド枚数の既定値。8枚は既存実装
// (STEP31以降の実機テスト)で扱われてきた典型的なスライド数を
// 踏まえた、控えめな既定値。
const DEFAULT_TARGET_SLIDES = 8;

// =========================
// artifactType別のallocation基準プロファイル(STEP52)
// =========================
//
// detailLevelに依存しない、「その成果物タイプでは何が相対的に
// 重要か」という基準。これをdetailLevelに応じて底上げ/抑制する
// (shiftAllocation)ことで、artifactType×detailLevelの全16通りを
// 手作業で書き下ろさずに導出する。
//
// 各項目の意味(既存Writer出力Schema、core/prompt/outputFormats.ts
// のフィールドに対応):
//   executiveSummary … executiveSummary
//   sections          … sections(本文の主要部分。Evidence/Analystの
//                        分析を最も反映する箇所であり、既存Writerが
//                        最も重視してきた項目)
//   keyFindings       … keyFindings
//   recommendations   … recommendations
//   nextActions       … nextActions

const ARTIFACT_TYPE_EMPHASIS: Record<
  ArtifactTypeForOutputSpec,
  OutputAllocation
> = {

  report: {
    executiveSummary: "medium",
    sections: "high",
    keyFindings: "medium",
    recommendations: "medium",
    nextActions: "low",
  },

  // Comparison: 比較対象・比較軸はsections(表を含む)に集約される。
  // keyFindingsは既存のbuildArtifactStyleGuidanceが求める「比較軸・
  // 差分」と重複しやすいため、報告書より抑えめにする。
  comparison: {
    executiveSummary: "medium",
    sections: "high",
    keyFindings: "low",
    recommendations: "medium",
    nextActions: "low",
  },

  // Proposal: 実行可能性(recommendations/nextActions)が意思決定に
  // 直結するため、他のartifactTypeより高めにする
  // (buildArtifactStyleGuidanceの「誰が・何を・どう進めるか」と
  // 整合させる)。
  proposal: {
    executiveSummary: "medium",
    sections: "high",
    keyFindings: "medium",
    recommendations: "high",
    nextActions: "medium",
  },

  // Presentation: 内容の大半はsections(=スライド本文)に集約され、
  // executiveSummary/keyFindings/recommendations/nextActionsは
  // 個別スライドとして重視されない(既存のbuildArtifactStyleGuidanceは
  // Slide形式の簡潔な箇条書きのみを求めている)。
  presentation: {
    executiveSummary: "low",
    sections: "high",
    keyFindings: "low",
    recommendations: "low",
    nextActions: "low",
  },

};

const ALLOCATION_LEVELS: AllocationLevel[] = ["low", "medium", "high"];

function shiftAllocationLevel(
  level: AllocationLevel,
  shift: number
): AllocationLevel {

  const index = ALLOCATION_LEVELS.indexOf(level);

  const next = Math.min(
    ALLOCATION_LEVELS.length - 1,
    Math.max(0, index + shift)
  );

  return ALLOCATION_LEVELS[next];

}

// detailLevelがbrief→deepへ上がるほど、各項目のallocationを
// 底上げする(brief: -1段階、standard: 変化なし、detailed: +1段階、
// deep: +2段階)。「low/medium/high」の3段階しかないため、
// 既に上限/下限の項目はそれ以上変化しない(自然にクランプされる)。
const DETAIL_LEVEL_ALLOCATION_SHIFT: Record<DetailLevel, number> = {
  brief: -1,
  standard: 0,
  detailed: 1,
  deep: 2,
};

function computeAllocation(
  artifactType: ArtifactTypeForOutputSpec,
  detailLevel: DetailLevel
): OutputAllocation {

  const base = ARTIFACT_TYPE_EMPHASIS[artifactType];
  const shift = DETAIL_LEVEL_ALLOCATION_SHIFT[detailLevel];

  return {
    executiveSummary: shiftAllocationLevel(base.executiveSummary, shift),
    sections: shiftAllocationLevel(base.sections, shift),
    keyFindings: shiftAllocationLevel(base.keyFindings, shift),
    recommendations: shiftAllocationLevel(base.recommendations, shift),
    nextActions: shiftAllocationLevel(base.nextActions, shift),
  };

}

// =========================
// modeによるdetailLevelへの補助的な影響(STEP52)
// =========================
//
// ユーザーが明示的にdetailLevelを指定した場合、modeは一切関与しない
// (要件7「ユーザーが『簡潔に』と指定しているのにdeep modeだから
// 大量に書く、という挙動にはしない」)。
// ユーザー指定がない場合のみ、artifactType既定値をmodeで
// 1段階だけ補正する(quick: -1, think: 0, deep: +1)。

const DETAIL_LEVEL_ORDER: DetailLevel[] = [
  "brief",
  "standard",
  "detailed",
  "deep",
];

const MODE_DETAIL_LEVEL_SHIFT: Record<ModeForOutputSpec, number> = {
  quick: -1,
  think: 0,
  deep: 1,
};

function shiftDetailLevel(level: DetailLevel, shift: number): DetailLevel {

  const index = DETAIL_LEVEL_ORDER.indexOf(level);

  const next = Math.min(
    DETAIL_LEVEL_ORDER.length - 1,
    Math.max(0, index + shift)
  );

  return DETAIL_LEVEL_ORDER[next];

}

// =========================
// ユーザー明示指定の検出(正規表現ベース)
// =========================

// STEP40のdetectResearchRequirement()と同じ教訓(語尾変化を網羅
// しきれない固定フレーズより、活用しにくい語幹で照合する方が
// 取りこぼしが少ない)を踏まえ、活用形(〜な/〜に/〜さ等)に
// 依存しない語幹で照合する(例:「簡潔な」「簡潔に」「簡潔さ」を
// すべて拾うため「簡潔」で照合する)。
const DEEP_PATTERN =
  /かなり詳し|非常に詳し|徹底的|網羅的|とことん詳し/;

const DETAILED_PATTERN =
  /詳しく|詳細|しっかり(と)?(まとめ|説明|書い)/;

const BRIEF_PATTERN =
  /短く|簡潔|簡単に|手短|コンパクト|要点だけ|要点のみ/;

// 「2000〜3000文字」「1000〜2000字程度」のような範囲指定。
const RANGE_CHARACTER_PATTERN =
  /(\d{2,6})\s*(〜|~|-|から)\s*(\d{2,6})\s*(文字|字)/;

// 「1000文字以内」「2000字まで」のような上限指定。
const MAX_CHARACTER_PATTERN =
  /(\d{2,6})\s*(文字|字)\s*(以内|まで)/;

// 「2000文字程度」「1000字くらい」のような目安指定。
const APPROX_CHARACTER_PATTERN =
  /(\d{2,6})\s*(文字|字)\s*(程度|くらい|前後|ほど)/;

// 「8枚以内」「10スライドまで」のような上限指定。
const MAX_SLIDE_PATTERN =
  /(\d{1,3})\s*(枚|スライド)\s*(以内|まで)/;

// 「8枚程度」「10スライドくらい」のような目安指定。
const APPROX_SLIDE_PATTERN =
  /(\d{1,3})\s*(枚|スライド)\s*(程度|くらい|前後)/;

// 極端な値(誤検出・不正な値)を弾くための妥当な範囲。
// OutputSpecが不正な値を持つ場合は安全にfallbackする(STEP51要件)。
const MIN_VALID_CHARACTERS = 50;
const MAX_VALID_CHARACTERS = 20000;
const MIN_VALID_SLIDES = 1;
const MAX_VALID_SLIDES = 60;

function isValidCharacterCount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_VALID_CHARACTERS &&
    value <= MAX_VALID_CHARACTERS
  );
}

function isValidSlideCount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_VALID_SLIDES &&
    value <= MAX_VALID_SLIDES
  );
}

function detectDetailLevel(userInput: string): DetailLevel | null {

  if (DEEP_PATTERN.test(userInput)) return "deep";
  if (DETAILED_PATTERN.test(userInput)) return "detailed";
  if (BRIEF_PATTERN.test(userInput)) return "brief";

  return null;

}

// STEP52: 上限のみだった検出を、範囲(min〜max)にも対応させた。
// 優先順位: 範囲指定 > 上限指定 > 目安(程度)指定。
function detectLengthPreference(
  userInput: string
): OutputSpec["lengthPreference"] | null {

  const rangeMatch = userInput.match(RANGE_CHARACTER_PATTERN);

  if (rangeMatch) {

    const min = parseInt(rangeMatch[1], 10);
    const max = parseInt(rangeMatch[3], 10);

    if (
      isValidCharacterCount(min) &&
      isValidCharacterCount(max) &&
      min < max
    ) {
      return { minCharacters: min, maxCharacters: max };
    }

  }

  const maxMatch = userInput.match(MAX_CHARACTER_PATTERN);

  if (maxMatch) {

    const value = parseInt(maxMatch[1], 10);

    if (isValidCharacterCount(value)) return { maxCharacters: value };

  }

  const approxMatch = userInput.match(APPROX_CHARACTER_PATTERN);

  if (approxMatch) {

    const value = parseInt(approxMatch[1], 10);

    if (isValidCharacterCount(value)) return { maxCharacters: value };

  }

  return null;

}

function detectTargetSlides(userInput: string): number | null {

  const maxMatch = userInput.match(MAX_SLIDE_PATTERN);

  if (maxMatch) {

    const value = parseInt(maxMatch[1], 10);

    if (isValidSlideCount(value)) return value;

  }

  const approxMatch = userInput.match(APPROX_SLIDE_PATTERN);

  if (approxMatch) {

    const value = parseInt(approxMatch[1], 10);

    if (isValidSlideCount(value)) return value;

  }

  return null;

}

// =========================
// resolveOutputSpec
// =========================
//
// 優先順位:
//   detailLevel        … ユーザー明示 > artifactType既定値(mode補正込み)
//   lengthPreference    … ユーザー明示 > (artifactTypeには既定値なし)
//   presentation        … ユーザー明示 > artifactType既定値
//   allocation           … artifactType×detailLevelから機械的に導出
//                          (ユーザーの自然言語からの個別指定はしない)
//
// userInputが空/不正な場合でもクラッシュせず、artifactType既定値
// (それも無ければstandard)へ安全にfallbackする。

export function resolveOutputSpec(
  userInput: string,
  artifactType: ArtifactTypeForOutputSpec,
  mode: ModeForOutputSpec = "think"
): OutputSpec {

  const defaultDetailLevel =
    ARTIFACT_TYPE_DEFAULT_DETAIL_LEVEL[artifactType] ?? "standard";

  const safeInput = typeof userInput === "string" ? userInput : "";

  const explicitDetailLevel = detectDetailLevel(safeInput);
  const explicitLengthPreference = detectLengthPreference(safeInput);
  const explicitTargetSlides = detectTargetSlides(safeInput);

  // STEP52: ユーザーが明示していない場合のみ、artifactType既定値を
  // modeで補助的に補正する(quick: 簡潔寄り、deep: 詳細寄り)。
  const detailLevel =
    explicitDetailLevel ??
    shiftDetailLevel(
      defaultDetailLevel,
      MODE_DETAIL_LEVEL_SHIFT[mode] ?? 0
    );

  const spec: OutputSpec = {
    detailLevel,
    allocation: computeAllocation(artifactType, detailLevel),
  };

  if (explicitLengthPreference) {
    spec.lengthPreference = explicitLengthPreference;
  }

  if (artifactType === "presentation") {

    const targetSlides =
      explicitTargetSlides ?? DEFAULT_TARGET_SLIDES;

    spec.presentation = { targetSlides };

  }

  return spec;

}

// =========================
// buildOutputSpecGuidance
// =========================
//
// OutputSpecを、Writer(および今後Writerを参照する他Agent)への
// Prompt上の指示文へ変換する。「必ずN文字」のような絶対命令には
// せず、目安・優先順位を明示する(STEP51要件8)。
// 品質優先(正確性→必要情報→構造→可読性→文字量)という既存の
// Writer思想(core/agents/writer.ts)と矛盾しない位置づけにする。

// STEP54: STEP53の実測で、standard→detailedの差(+8%)がbrief→standard
// (+48%)やdetailed→deep(+43%)と比べて明確に弱いことが判明した。
// 各段階の役割をより具体的に書き分け、特にstandardとdetailedの違いが
// Prompt上でも明確になるようにした。

const DETAIL_LEVEL_DESCRIPTIONS: Record<DetailLevel, string> = {

  brief:
    "必要不可欠な情報に絞ってください。重要なEvidenceと結論を優先し、" +
    "背景説明・前提の解説など、なくても結論が成立する情報は" +
    "省いてください。",

  standard:
    "通常の十分な説明を行ってください。主要なEvidence・背景・分析を" +
    "含め、読者がこの内容だけで判断できる程度の情報量にしてください。",

  detailed:
    "standardより一段深い説明を行ってください。重要な論点については、" +
    "背景・因果関係・比較・根拠など「なぜそう言えるのか」まで" +
    "掘り下げてください。単にstandardの文章を引き伸ばすのではなく、" +
    "standardには含めなかった追加の分析・具体例・根拠を加えて" +
    "ください。ただし、Evidenceにない推測を追加してはいけません。",

  deep:
    "最も深い分析を行ってください。主要な論点について、背景・根拠・" +
    "含意・比較などを十分に掘り下げてください。ただし、ただ長く" +
    "するのではなく、追加する情報に意味がある場合のみ詳しくして" +
    "ください。Evidenceが不足している論点は、無理に分量を増やさず、" +
    "不足している旨を示してください。",

};

const ALLOCATION_FIELD_LABELS: Record<keyof OutputAllocation, string> = {
  executiveSummary: "executiveSummary",
  sections: "sections(本文)",
  keyFindings: "keyFindings",
  recommendations: "recommendations",
  nextActions: "nextActions",
};

// STEP54: STEP53の実測で、keyFindings/recommendations/nextActionsの
// 文字量がallocationと弱い相関しか示さず、detailLevel間で逆転すら
// 発生した(例: recommendationsがbrief=65字よりstandard=135字の方が
// 多い)。原因の一つとして、各フィールドの「役割の違い」がPromptで
// 明確でなく、Writerが実質的に同じような内容(sectionsの要約の
// 言い換え等)を書いてしまい、量の指示だけでは差が出にくかった
// 可能性がある。
//
// そのため、各フィールドに「役割(何のためのフィールドか。
// 他フィールドとどう違うか)」を固定文として与え、そのうえで
// allocation levelごとに「どこまで踏み込むか」を指示する、という
// 二段構成にした。「highだから文字数を増やす」ではなく「highの
// 場合、そのフィールドに必要な情報をより十分に含める」という
// 考え方(要件3)を徹底する。

const ALLOCATION_FIELD_ROLES: Record<keyof OutputAllocation, string> = {

  executiveSummary:
    "全体像を短く把握できるようにする要約。本文(sections)の詳細な" +
    "説明を繰り返さない。",

  sections:
    "主たる情報源。Evidenceに基づく具体的な説明・分析をここに集約する。" +
    "detailLevelが高いほど、ここを最も厚くする。",

  keyFindings:
    "調査から得られた重要な発見の整理。sectionsの内容を単純に" +
    "コピー・要約しただけのものにしない。重要度の高い発見を優先する。",

  recommendations:
    "Evidenceから合理的に導ける具体的な提案。数を無理に増やさない" +
    "(該当する提案がなければ少数、あるいは空配列でよい)。",

  nextActions:
    "読者が次に取るべき行動。recommendationsの単なる言い換えにせず、" +
    "『次の一歩』として何をすべきかを示す。必要なものだけを提示する。",

};

// フィールドごとのlevel別ガイダンス。「量」ではなく「その量で
// 何をすべきか」を具体的に指示する。
const ALLOCATION_FIELD_GUIDANCE: Record<
  keyof OutputAllocation,
  Record<AllocationLevel, string>
> = {

  executiveSummary: {
    low: "要点のみ数行程度にまとめる。",
    medium: "主要な結論が過不足なく伝わる程度にまとめる。",
    high: "背景・結論・示唆まで含め、しっかりと展開する。",
  },

  sections: {
    low: "簡潔に要点を示す程度に留める。",
    medium: "標準的な情報量で、事実・分析・結論を展開する。",
    high: "最も情報量を割く箇所として、Evidence・Analystの分析を" +
      "十分に展開する。",
  },

  keyFindings: {
    low: "特に重要な発見のみ、1〜2件に絞り込んで示す。",
    medium: "主要な発見を過不足なく示す。",
    high: "重要な発見を幅広く示す。detailLevelがdetailed/deepの" +
      "場合は、各発見について根拠(どのEvidenceから言えるか)や" +
      "意味(なぜ重要か)を一言添える。",
  },

  recommendations: {
    low: "該当する場合のみ、要点を絞って示す。",
    medium: "実行可能性を意識しつつ、主要な提案を示す。",
    // STEP97: 「high配分だから具体的な提案を示す」という無条件の
    // 要求が、直前のrole説明にある「該当する提案がなければ空配列
    // でよい」という許可を実質的に無効化し、Evidence不足時にも
    // Writerが提案を自発生成してしまうことを実測で確認した
    // (Condition A/B: recommendationsCountが常に2件、Evidence=0でも
    // 自発生成率100%)。「high提案要求を除去するだけ」の条件(B)では
    // 改善せず、「Evidenceから導ける提案が無い場合は空配列のまま」
    // という条件を明示的に追記した条件(C)でのみ、自発生成が
    // 3/3で完全に止まることを実測で確認したため、その文言を反映する。
    high: "実行可能性を重視し、Evidenceから合理的に導ける提案が" +
      "存在する場合は具体的な提案を示す。detailLevelがdetailed/deep" +
      "の場合は、各提案について理由(なぜその提案に至るか)や" +
      "期待効果を添える。ただし、Evidenceから合理的に導ける提案が" +
      "存在しない場合は、無理に提案を作らず、recommendationsは" +
      "空配列のままにしてください。",
  },

  nextActions: {
    low: "本当に必要なものだけに絞る(不要なら空配列のままでよい)。",
    medium: "次に取るべき行動を過不足なく示す。",
    high: "次に取るべき行動を具体的に示す。recommendationsと文言が" +
      "重複しないよう、『誰が』『何を』『いつまでに』のような" +
      "行動レベルの粒度にする。",
  },

};

function buildAllocationGuidance(allocation: OutputAllocation): string {

  const lines = (
    Object.keys(allocation) as (keyof OutputAllocation)[]
  ).map((field) => {

    const level = allocation[field];

    return (
      `- ${ALLOCATION_FIELD_LABELS[field]}(役割: ` +
      `${ALLOCATION_FIELD_ROLES[field]}）\n` +
      `  今回の配分(${level}): ${ALLOCATION_FIELD_GUIDANCE[field][level]}`
    );

  });

  return [
    "各項目への相対的な情報配分の目安です" +
    "(絶対的な文字数指定ではありません。Evidence量や実際の" +
    "タスク内容を見て調整して構いません)。" +
    "重要: 「配分が高い=文字数を増やす」ではなく、" +
    "「配分が高い場合、その項目に必要な情報をより十分に含める」" +
    "という意味です。各項目は役割が異なるため、他の項目の内容を" +
    "言い換えただけの文章で埋めないでください:",
    ...lines,
  ].join("\n");

}

export function buildOutputSpecGuidance(spec: OutputSpec): string {

  const lines: string[] = [
    "この成果物で目指す出力量の目安(Output Spec)です。",
    "",
    `詳細度: ${spec.detailLevel}`,
    DETAIL_LEVEL_DESCRIPTIONS[spec.detailLevel],
  ];

  if (
    spec.lengthPreference?.minCharacters &&
    spec.lengthPreference?.maxCharacters
  ) {

    // STEP54: STEP53の実測で、範囲指定(min〜max)の下限が大きく
    // 下回られる(指定2000文字に対し実測1383文字)ことが判明した。
    // 上限指定(「以内」)は守られていたため、そちらの文言
    // (else if側)は変更せず、範囲指定側だけ「下限を下回らないよう
    // 十分な説明を行う」ことを明確に指示する。
    // 一方で、Evidence不足時に下限達成のため水増しする挙動は
    // 絶対に避けるべきため、既存のEvidence Guard方針をこの指示の
    // 中でも明示的に維持する。
    lines.push(
      "",
      `全体の文字数の目安: およそ${spec.lengthPreference.minCharacters}` +
      `〜${spec.lengthPreference.maxCharacters}文字程度。これは目安で` +
      "あり、厳密な範囲ではありません。可能な限り下限を大きく下回ら" +
      "ないよう、必要な背景・根拠・分析を十分に説明したうえで、" +
      "上限を超えないように重要度の低い情報から調整してください。" +
      "ただし、Evidenceが不足している場合は例外です。下限に到達" +
      "させるためだけに、存在しない情報を作り上げたり、同じ内容を" +
      "冗長に繰り返したり、根拠のない推測を追加したりしてはいけま" +
      "せん。Evidenceが不足している場合は、必要な情報が存在する" +
      "範囲で簡潔にまとめ、不足している旨をlimitations等で示して" +
      "ください。"
    );

  } else if (spec.lengthPreference?.maxCharacters) {

    lines.push(
      "",
      `全体の文字数の目安: およそ${spec.lengthPreference.maxCharacters}` +
      "文字程度。これは厳密な上限ではなく目安です。正確性や必要な" +
      "情報を犠牲にしてまで無理に文字数を合わせる必要はありませんが、" +
      "大きく超過しないよう、重要度の低い情報から優先的に絞り込んで" +
      "ください。"
    );

  }

  if (spec.presentation?.targetSlides) {

    lines.push(
      "",
      `スライド枚数の目安: ${spec.presentation.targetSlides}枚程度。` +
      "厳密な枚数指定ではなく目安です。内容上必要な場合は前後して" +
      "構いませんが、大きく超過しないよう重要度の低いスライドは" +
      "統合・削減してください。"
    );

  }

  lines.push(
    "",
    buildAllocationGuidance(spec.allocation)
  );

  lines.push(
    "",
    "優先順位: 正確性 > 必要情報 > 構造 > 可読性 > 指定文字量への" +
    "適合、の順で判断してください。ただし、ユーザーが明示的に" +
    "文字数・枚数の上限を指定した場合は、その制約をできる限り" +
    "尊重してください。",
    "",
    "すべてのsectionを均等な文字数にする必要はありません。重要な" +
    "sectionは詳しく、補足的なsectionは簡潔に、というように、" +
    "情報の重要度に応じて配分してください。"
  );

  return lines.join("\n");

}
