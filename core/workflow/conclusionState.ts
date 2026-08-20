// =========================
// conclusionState (STEP106)
// =========================
//
// 背景: STEP101-104の実測で、Writerが「Analystが優先順位付けを
// 保留している」状態を無視し、「AもBも重要、バランスよく育成すべき」
// のような未支持の規範的結論をExecutiveSummaryへ生成してしまう問題が
// 繰り返し確認された。STEP103では生成後のCritique/Revisionによる
// 事後修正を試したが、再Critiqueの誤検出率が70〜80%に達し信頼できな
// かった。STEP104では、Analystの結論状態(HOLD/DECIDED)を生成前に
// 構造化してWriterへ渡す方式(Structured HOLD/DECIDED)を検証し、
// 未支持結論率をBaseline 73%→0%(局所Revision併用時)まで改善できる
// ことを実測した(STEP105で設計を確定)。
//
// 本モジュールは、STEP71のQualityProfile(core/workflow/
// qualityProfile.ts)・STEP39のIdea Mode(core/workflow/ideaMode.ts)
// と同じ設計パターン(型定義+判定関数を1ファイルに集約し、
// WorkflowContextへ載せ、runAgent.ts/handlePlanner.ts等が参照する)を
// 踏襲する。core/brain/(実行結果の事後評価専任)やcore/prompt/
// builder.ts(純粋なテンプレート整形)ではなく、Workflow層の状態判定
// としてここに置く(STEP105設計での判断)。
//
// 重要: 状態は2種類(HOLD/DECIDED)のみ。STEP105で検討した
// INSUFFICIENT_EVIDENCEは、HOLDのreasonフィールドとして吸収する
// (Writerの許可される挙動がHOLDと変わるという実測的根拠が無いため、
// 投機的に3状態化しない)。

import { AnalystOutput, EvidenceReferencingItem } from "../evidence/validateEvidenceIds";

export type ConclusionStatus = "HOLD" | "DECIDED";

export interface ConclusionState {
  status: ConclusionStatus;

  // 現時点ではAnalystの出力からのみ判定するため常に"analyst"。
  source: "analyst";

  // 判定根拠(ログ・デバッグ用)。該当するrecommendation.actionや、
  // recommendationsが存在しない旨をそのまま記録する。
  reason: string;

  // WriterがExecutiveSummaryへ新しい優先順位・規範的結論を
  // 生成してよいか。status: "DECIDED" の場合のみtrue。
  allowNewConclusion: boolean;
}

// 保留系action文言のパターン。STEP101-104の固定Violation実験・
// core/workflow/runAgent.ts内の既存STEP94ブロックで使われていた
// キーワード集合をそのまま踏襲する(新しいキーワード集合の新設はしない)。
const HOLD_ACTION_PATTERN =
  /保留|一意に判断できない|一意に決定できない|優先順位を決められない|判断できない/;

// =========================
// resolveConclusionState
// =========================
//
// AnalystOutput.recommendationsから、現在のConclusionStateを判定する。
//
// 重要(STEP106指示): 「recommendationsなし = 本質的に必ずHOLD」という
// 意味ではない。現行のAnalyst Output Format(core/prompt/
// outputFormats.ts)には、Analyst自身が明示的に返す
// ConclusionStatusに相当するフィールドが存在しない。そのため本関数は
// 「recommendationsの内容から間接的に推測する」という暫定実装であり、
// 将来Analyst側に明示的なstatusフィールドが追加された場合は、
// そちらを優先して読み替えられるように設計してある(下記参照)。
//
// 安全側デフォルト: recommendationsが欠損・不正な型・空・一部/全部が
// 保留系文言、のいずれの場合もHOLDとする。DECIDEDと判定するのは、
// recommendationsが1件以上存在し、かつそのいずれにも保留系文言が
// 含まれない場合のみ。過剰生成(未支持結論)より過剰抑制の方が
// STEP104実測上のリスクが低いため。
export function resolveConclusionState(
  analystOutput: AnalystOutput | null | undefined
): ConclusionState {
  // recommendations自体が欠損・不正な型の場合(analystOutputが
  // null/undefined、recommendationsがundefined/null/配列でない等)。
  if (
    !analystOutput ||
    !Array.isArray(analystOutput.recommendations)
  ) {
    return {
      status: "HOLD",
      source: "analyst",
      reason:
        "recommendations未提示(Analyst出力が存在しないか、recommendationsが配列ではない)",
      allowNewConclusion: false,
    };
  }

  const recommendations = analystOutput.recommendations;

  // recommendations = [] の場合。
  if (recommendations.length === 0) {
    return {
      status: "HOLD",
      source: "analyst",
      reason: "recommendations未提示",
      allowNewConclusion: false,
    };
  }

  // 各recommendationのaction文言を安全に文字列化する。
  // action自体が欠損・空文字列・不正な値でも例外を投げない。
  const actionTexts = recommendations.map((rec) =>
    extractActionText(rec)
  );

  // actionが欠損・空文字列・非文字列・recommendation自体が不正な値
  // だった項目(=有効なaction文字列を取り出せなかった項目)は、
  // それ自体を「保留系文言と同様に安全側でHOLDへ倒す理由」として
  // 扱う。actionを読み取れないことは「明示的な結論」とは言えない
  // ため、これをDECIDED側の根拠にしてはいけない(STEP106指示:
  // action欠損等でも安全側デフォルトはHOLD)。
  const invalidCount = actionTexts.filter((text) => text.length === 0).length;

  const holdMatches = actionTexts.map((text) =>
    text.length > 0 && HOLD_ACTION_PATTERN.test(text)
  );

  const allHold = holdMatches.every((matched) => matched);
  const anyHold = holdMatches.some((matched) => matched);

  if (allHold) {
    return {
      status: "HOLD",
      source: "analyst",
      reason: `Analystのrecommendationsが保留を示している: ${actionTexts.join(" / ")}`,
      allowNewConclusion: false,
    };
  }

  if (invalidCount > 0) {
    return {
      status: "HOLD",
      source: "analyst",
      reason: `recommendationsの一部でactionを読み取れなかったため安全側でHOLDとする(有効なaction数: ${
        actionTexts.length - invalidCount
      }/${actionTexts.length})`,
      allowNewConclusion: false,
    };
  }

  // 一部だけが保留系文言の場合(混在ケース)。安全側デフォルトとして
  // HOLDを優先する(STEP106指示: 未検証の混在ケースでは過剰抑制の
  // 方を選ぶ)。
  if (anyHold) {
    return {
      status: "HOLD",
      source: "analyst",
      reason: `recommendationsの一部が保留を示しているため安全側でHOLDとする: ${actionTexts.join(" / ")}`,
      allowNewConclusion: false,
    };
  }

  // 上記のいずれにも該当しない(recommendationsが1件以上あり、
  // すべてに有効なaction文字列が存在し、かついずれも保留系文言を
  // 含まない)場合のみDECIDED。
  return {
    status: "DECIDED",
    source: "analyst",
    reason: `Analystが明示的な結論を示している: ${actionTexts.join(" / ")}`,
    allowNewConclusion: true,
  };
}

// recommendation項目からaction文言を安全に取り出す。
// actionが欠損・undefined・非文字列・空文字列でも例外を投げず、
// 空文字列を返す(呼び出し側でこの空文字列は「有効なactionを
// 読み取れなかった」ことの印として扱われ、安全側のHOLD判定に
// つながる。DECIDEDへ倒れる根拠には決してならない)。
// recommendation自体が不正な値の場合も同様に空文字列として扱う。
function extractActionText(rec: EvidenceReferencingItem | unknown): string {
  if (!rec || typeof rec !== "object") {
    return "";
  }

  const action = (rec as { action?: unknown }).action;

  return typeof action === "string" ? action : "";
}

// =========================
// buildConclusionStateBlock
// =========================
//
// STEP104 Condition C/Dで実測検証済みのStructured HOLD/DECIDEDブロック
// をproduction用に実装したもの。core/workflow/runAgent.ts内の既存
// addendumパターン(userPromptへ文字列を追記するだけ)と同じ形で
// 呼び出し元が連結する。buildPrompt()自体のシグネチャは変更しない。
export function buildConclusionStateBlock(state: ConclusionState): string {
  if (state.status === "HOLD") {
    return `

========================
Conclusion State(STEP106: Analystの現在の結論状態)
========================

\`\`\`
CURRENT CONCLUSION STATE
STATUS: HOLD
SOURCE: analyst
REASON: ${state.reason}

ALLOWED BEHAVIOR:
- Evidenceの内容を整理・要約すること
- Analystの分析(insights/comparisons/opportunities/risks)を説明すること
- 不確実性や、判断に必要な追加調査の必要性を説明すること
- Analystの保留状態を、別の表現へ言い換えて伝えること

FORBIDDEN BEHAVIOR:
- 新しい優先順位を導入すること
- 新しい「〜すべき」「〜が求められる」等の規範的結論を追加すること
- Analystが示していない具体的な方針・提案を追加すること
- HOLDを、表現を変えただけの具体的な結論(例:「両方をバランスよく
  育成すべき」「両者を一緒に育成する方針」等)へ変換すること
\`\`\`

上記はAnalystの現在の結論状態を構造化して示したものです。

このConclusion State制約は、本Prompt内の他の指示(禁止された結論
パターンを避ける指示を含む)と内容が競合する場合、優先されます。
他の指示に従うことがFORBIDDEN BEHAVIORに該当する結果を招く場合は、
Conclusion Stateの制約を優先してください(STEP108)。

STATUS: HOLD の場合、ExecutiveSummaryはALLOWED BEHAVIORの範囲内でのみ
記述してください。FORBIDDEN BEHAVIORに該当する内容は、表現を変えても
生成してはいけません。

重要:
これは「判断できません」という一文だけで終わらせることを意味しません。
Evidenceの内容・Analystの分析・対立する論点・不足している判断材料を
十分に説明した、実質的なExecutiveSummaryを維持してください。
`;
  }

  return `

========================
Conclusion State(STEP106: Analystの現在の結論状態)
========================

\`\`\`
CURRENT CONCLUSION STATE
STATUS: DECIDED
SOURCE: analyst
REASON: ${state.reason}

ALLOWED BEHAVIOR:
- Analystが示した結論・優先順位をそのまま伝えること
- その結論の根拠を説明すること
- 結論を明確化・文脈化すること

FORBIDDEN BEHAVIOR:
- Analystが決定済みの結論を、不要にHOLD(両論併記・保留)へ戻すこと
- Analystが示していない新しい優先順位・規範的結論を追加すること
- 過度な慎重さから、Analystが既に示した結論の言及を省略すること
\`\`\`

上記はAnalystの現在の結論状態を構造化して示したものです。
STATUS: DECIDED の場合、Analystが既に示した結論をExecutiveSummaryへ
明確に反映してください。判断を避けたり、両論併記へ後退させては
いけません。
`;
}

// =========================
// buildWriterAnalystView (STEP111)
// =========================
//
// 背景: STEP106でconclusionStateBlockを導入したが、STEP108の
// Regression Testで、Analystのrecommendations配列自体は
// buildPrompt()のpreviousOutputs経由でWriterへ無加工のまま渡り
// 続けていることが判明した(STEP109で特定)。Case E(recommendations
// に保留系と決定系が混在するケース)では、Resolverが正しくHOLDと
// 判定しているにもかかわらず、Writerが生データ内の決定系
// recommendation(例:「AIスキルを優先して導入すべき」)をそのまま
// ExecutiveSummaryへ採用してしまう「模倣型」の失敗が実測された。
//
// 本関数は、Writerのprompt生成時に限り、Analyst出力の
// recommendationsフィールドだけをConclusionStateに応じて加工した
// 「View」を返す(STEP110で確定した案D+案B-1)。
//
// ・status !== "HOLD"(DECIDEDまたはconclusionState未定義)の場合は
//   analystOutputを完全に無加工で返す。STEP108で確認済みの
//   DECIDED時100%成功、およびWriterがrecommendations全体を
//   参照できる挙動を一切変更しない。
// ・status === "HOLD"の場合のみ、recommendationsを保留系文言
//   (HOLD_ACTION_PATTERNに一致する項目)だけへフィルタする
//   (案B-1: 除外方式。注釈付与ではなく除外を選んだ理由は、
//   STEP106でconclusionStateBlockという明示的な制約ブロックでさえ
//   近接する具体的な指示に負けた実測があるため、注釈より確実な
//   「そもそも見えなくする」方式を採用した)。
//
// insights/comparisons/opportunities/risks/summary/confidence/
// confidenceReance等、recommendations以外のフィールドは一切
// 削除・加工しない(STEP110の評価表で「HOLD説明に必要」と判断した
// フィールドを削らないため)。
//
// STEP111のRegression Testで、recommendationsを保留系へフィルタしても
// Case E(recommendations混在)の成功率は変化せず(20%→20%)、Writerが
// 代わりにopportunitiesフィールド(例:「AI活用スキル研修プログラムの
// 構築」)から同種の決定的な結論を合成することが判明した。Case C/F
// (recommendations=[])でも、insights/risks/opportunitiesという
// 正当なHOLD説明材料そのものから、「両方重要だからバランスよく」
// という統合結論が合成される問題が確認された(STEP112で調査)。
//
// これらのフィールドはHOLD説明に必要なため削除できない(STEP110で
// 判断済み)。そこでSTEP112では、フィールドを削る代わりに、HOLD時のみ
// ANALYSTセクション自体に「この分析材料は判断材料であり、統合結論の
// 生成材料ではない」という注釈(_conclusionStateGuidance)を追加する。
// conclusionStateBlock(別セクション、Prompt末尾寄り)による一般的な
// 指示だけでは、insights/opportunities/risksという豊富で説得力のある
// 分析材料に近接した位置での効果が不十分だった(STEP106/111の実測)
// ため、分析材料そのものに隣接する位置に短い注釈を置く。新しいフィールドを
// 追加するだけであり、既存フィールドの削除・加工はrecommendations
// 以外には行わない。
//
// context.outputs自体(呼び出し元が保持する生データ)は変更しない。
// この関数は新しいオブジェクトを返すだけであり、副作用を持たない。
export function buildWriterAnalystView(
  analystOutput: AnalystOutput | null | undefined,
  state: ConclusionState | null | undefined
): AnalystOutput | null | undefined {
  if (!analystOutput) {
    return analystOutput;
  }

  if (!state || state.status !== "HOLD") {
    return analystOutput;
  }

  const recommendations = Array.isArray(analystOutput.recommendations)
    ? analystOutput.recommendations
    : [];

  const holdOnlyRecommendations = recommendations.filter((rec) =>
    HOLD_ACTION_PATTERN.test(extractActionText(rec))
  );

  return {
    _conclusionStateGuidance:
      "重要(STEP112): 以下のinsights/comparisons/opportunities/risksは、" +
      "現時点で優先順位・方針を決定できない理由を説明するための分析材料です。" +
      "これらを根拠に新しい統合的結論・規範的提言を作成しないでください。" +
      "recommendationsが保留状態であることは、ExecutiveSummaryでも維持して" +
      "ください。",
    ...analystOutput,
    recommendations: holdOnlyRecommendations,
  };
}

// =========================
// buildPhase1DeferralBlock (STEP113)
// =========================
//
// 背景: STEP112までの実測で、HOLD時にWriterへどれだけ「新しい結論を
// 作るな」と指示しても、Case C/F(recommendations=[]、insights/risks/
// opportunitiesが唯一の材料)では、Writerが1回の生成の中で「事実→
// 分析→統合結論」という既存の生成習慣(responsibilities.ts「結論から
// 書く」・writer.tsシステムプロンプト「事実→分析→結論」)に引っ張られ、
// 新しい統合結論を合成してしまう問題が残っていた(STEP112実測:
// C/F GEN単体で0%→20%止まり)。
//
// STEP113で、HOLD時のExecutiveSummary生成を「事実・分析の要約
// (Phase1)」と「なぜ判断できないかの結論(Phase2、
// core/workflow/runAgent.tsのgenerateHoldConclusion()が担当)」に
// 分離したところ、Case Cが20%→80%まで改善することを実測した
// (「分析→新しい統合結論」という生成経路そのものを、1回の生成の中で
// 完結させないことで切断する)。
//
// 本関数はPhase1(1回目の生成)専用の追加addendumを返す。status ===
// "HOLD"の場合のみ意味を持つ(呼び出し側でstatus判定を行う。DECIDED/
// 未定義時にこの関数を呼ばないこと)。buildConclusionStateBlock()の
// ALLOWED BEHAVIOR(「なぜ判断できないかの説明」を書いてよい)を、
// このPhase1の生成に限り一時的に狭める内容になっている点に注意
// (Phase2で「なぜ判断できないか」を追加するため、Phase1では書かない)。
export function buildPhase1DeferralBlock(state: ConclusionState): string {
  if (state.status !== "HOLD") {
    return "";
  }

  return `

========================
段階的生成(STEP113: Phase 1/2)
========================

今回のexecutiveSummaryは2段階で作成します。これは1回目の生成です。

このexecutiveSummaryでは、以下だけを書いてください。

・Evidenceから確認できる事実
・Analystの分析(insights/risks/opportunities)の要約
・対立する論点・不確実性

上記のConclusion Stateブロックが許可している「なぜ判断できないかの
説明」も、この1回目の生成では書かないでください。それは2回目の生成で
追加します。

以下は今回も今後も書いてはいけません。

・優先順位に関する結論
・「〜すべき」「〜が求められる」等の規範的な文
・「バランスよく」「両方進めるべき」等の統合的な提言

事実と分析の要約だけで文章を終えてください。結論部分を書かずに
文章を終えることは、今回に限り問題ありません。

重要: 本Prompt内の「禁止された結論の形」に関する指示(ユーザーが
避けるよう求めた結論パターンを避けるため、Analystの分析を使って
一段踏み込んだ結論へ書き直す、という指示)は、この1回目の生成には
適用しないでください。「一段踏み込む」ことは2回目の生成が担当します。
この1回目の生成でそれを先取りして行う必要はありません。
`;
}
