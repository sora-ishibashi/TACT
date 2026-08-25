import type { ExecutionCapability } from "./types";
import type { ArtifactBlock } from "../tact-artifact/types";
import type { ResearchEvidenceItem } from "../tact-research/types";
import {
  createEvidenceBlock,
  createExampleBlock,
  createFindingBlock,
  createHypothesisBlock,
  createRecommendationBlock,
  createResearchSummaryBlock,
  createTextBlock,
  nextOrder,
} from "../tact-artifact/blocks";

// =========================
// TACT Conversation — Artifact Mutation (Phase 75、Phase76でBlock構築に対応)
// =========================
//
// tact_artifacts / tact_conversations.artifact_idのmigration
// (supabase/migrations/20260827000000_create_tact_artifacts.sql)は
// 実DBへ適用済み(`supabase migration list`で確認済み)。
// core/tact-conversation/orchestration.tsがこのファイルの関数を使い、
// core/tact-artifact/*・core/tact-conversation/store.tsの
// Conversation.artifactId永続化と結線している。
//
// このファイルは引き続きDB/LLM呼び出しを一切含まない、純粋関数のみを
// 実装する(Section16の責務分離: 1. Artifactの概念・責務を確定 /
// 3. Artifact Mutation判定)。
//
// 絶対条件: 実LLM呼び出しは一切行わない。すべて決定論的な
// keyword-based heuristic(Section4「過度に複雑化しない」)。Phase76で
// 追加したclassifyArtifactMutation()・buildBlocksForMutation()も同じ
// 方針を維持する(Table/Chartは既存Blockから決定論的に導出する、
// core/tact-artifact/blocks.ts参照)。

// =========================
// detectArtifactMutationIntent
// =========================
//
// Section4の分類基準に基づく最小判定:
//   1. plan.capability==="research"(実際にResearch Capabilityが
//      実行された、Phase69で確立済みの信頼できる既存signal)は
//      常にArtifact更新対象とする(Case C)。
//   2. capabilityが"research"でなくても、明示的な追加・更新指示
//      (Section4の「具体例追加/比較追加/表作成/グラフ作成/成果物に
//      追加して」等の例)に一致する場合は対象とする(Case D/E/F)。
//      いずれも「〜して」という指示形の語尾を持つ語彙のみを対象とし、
//      「〜について教えて」等の単純な質問(Case B)を誤って対象に
//      しないようにする(Section4 Case B「既存情報についての説明要求」
//      を除外するための意図的な設計)。
//   3. それ以外(挨拶・雑談・単純質問・Clarification回答)は対象外
//      (Case A/B)。

const EXPLICIT_MUTATION_PHRASES = [
  "追加して",
  "まとめて",
  "表にして",
  "表にまとめ",
  "グラフにして",
  "グラフ化して",
  "反映して",
  "成果物に",
  "更新して",
  "修正して",
  "変更して",
  // Phase79 Section9: Comparison Table Mutationの追加語彙
  // (「表」という単語を含まない比較指示も対象にする)。
  // classifyArtifactMutation()のTABLE_CHART_PHRASESと同期させる。
  "比較して",
  "ごとに整理して",
];

export function detectArtifactMutationIntent(
  userInput: string,
  capability: ExecutionCapability
): boolean {

  if (capability === "research") {
    return true;
  }

  return EXPLICIT_MUTATION_PHRASES.some((phrase) => userInput.includes(phrase));

}

// =========================
// deriveArtifactTitle (Phase75、Phase77-Aで決定論的に改善)
// =========================
//
// Repository Evidence(Phase77investigation): 改善前はuserInput全文を
// そのまま(40文字超は単純truncate)Artifact titleへ使っており、
// 「愛知県の大学生が参加しやすいスポーツイベントについて調査して。
// 参加者を増やすための施策を考える前提で、現状・課題・傾向を整理して。」
// のような依頼文がほぼそのままtitleになっていた(Phase77 Section2)。
//
// LLM呼び出しを追加せず(Section2「まず決定論的な改善案を検討する」)、
// 以下の決定論的な変換だけで改善する:
//   1. 複数文にまたがる依頼(「〜調査して。〜整理して。」)は、最初の
//      文(最初の「。」まで)だけを対象にする——後続の文は「目的の
//      説明」であって「調査対象」そのものではないことが多いため。
//   2. INSTRUCTION_SUFFIXES(「について調査して」「を調べて」等、
//      命令文の語尾)を末尾から繰り返し取り除く。「〜して」という
//      指示形の語尾を持つ語彙のみを対象とする既存方針
//      (detectArtifactMutationIntent()と同じSection4の考え方)を
//      titleにも適用し、「調査して」「追加して」「表にして」等の
//      命令文をtitleに含めない(Section2の明示的な要求)。
//   3. 取り除いた結果、空文字になった場合(入力全体が命令句だけ、
//      例:「調べて」)は、意味のあるtitleを失わないよう、元の
//      (文分割後の)テキストへ安全側でフォールバックする。
//
// Artifact全体のtitleは初回作成時(createArtifact()呼び出し時)にのみ
// この関数を通す——更新時は呼ばれない(既存の呼び出し構造のまま、
// Section2「Artifact更新時に毎回titleを変更しない」を維持)。各Block
// 個別のtitle(buildResearchMutationBlocks()等)にも同じ関数を使うが、
// これはBlockごとに1回だけ生成される値であり、Artifact全体のtitleとは
// 別のフィールド(既存の設計どおり)。

const TITLE_MAX_LENGTH = 40;

// 長い語彙から先に一致させる(短い「して」が先に一致して「について
// 調査して」の「について調査」部分を残してしまうことを防ぐため、
// 呼び出し側でlengthの降順にソートして使う)。
const INSTRUCTION_SUFFIXES = [
  "について調査してください",
  "について調べてください",
  "について調査して",
  "について調べて",
  "について整理して",
  "についてまとめて",
  "を調査してください",
  "を調べてください",
  "を調査して",
  "を調べて",
  "を整理して",
  "を追加してください",
  "を追加して",
  "にまとめてください",
  "にまとめて",
  "をまとめてください",
  "をまとめて",
  "まとめてください",
  "まとめて",
  "を作成してください",
  "を作成して",
  "について教えてください",
  "について教えて",
  "を教えてください",
  "を教えて",
  "教えてください",
  "教えて",
  "をお願いします",
  "をお願い",
  "してください",
  "して",
].sort((a, b) => b.length - a.length);

// 文末の句読点・記号を取り除く(命令句を剥がした後に残りがちな
// 「。」「、」等)。
function trimTrailingPunctuation(text: string): string {
  return text.replace(/[。、.,!！?？\s]+$/u, "");
}

function stripInstructionSuffixes(text: string): string {

  let current = trimTrailingPunctuation(text.trim());

  // 1回のstripで複数の命令句が連なっている場合(「〜を調査して整理して」
  // 等)にも対応できるよう、一致しなくなるまで繰り返す。無限loop防止の
  // ため、必ず文字列が短くなる場合のみ継続する。
  let changed = true;

  while (changed) {

    changed = false;

    for (const suffix of INSTRUCTION_SUFFIXES) {

      if (current.endsWith(suffix) && current.length > suffix.length) {

        current = trimTrailingPunctuation(current.slice(0, -suffix.length));
        changed = true;
        break;

      }

    }

  }

  return current;

}

// Phase79 Section14: 「イベント名・地域・対象者で比較表にして」の
// ような比較指示は、末尾の「〜して」だけ剥がしても
// (INSTRUCTION_SUFFIXESの対象外である比較軸の列挙部分が残るため)
// 依頼文がほぼそのままtitleになってしまう。「[対象]を、[列挙]で
// 比較/整理/表に…」という典型構文(parseComparisonColumns()が列挙
// 抽出に使うのと同じ構文)を検出した場合、「を、」より前の対象部分
// だけを残す。「を、」が無い場合(列挙の直前に明確な対象境界が無い
// 表現)は無理に切り詰めず、後続のstripInstructionSuffixes()による
// 末尾除去だけに委ねる。
const COMPARISON_CLAUSE_PATTERN = /で(?:比較|整理|表に)/;

function stripComparisonClause(text: string): string {

  if (!COMPARISON_CLAUSE_PATTERN.test(text)) {
    return text;
  }

  const objectBoundary = text.indexOf("を、");

  return objectBoundary === -1 ? text : text.slice(0, objectBoundary);

}

export function deriveArtifactTitle(userInput: string): string {

  const trimmed = userInput.trim();

  // 最初の文だけを対象にする(複数文にまたがる依頼の後半は「目的の
  // 説明」であることが多く、調査対象そのものではないため)。
  const firstSentenceEnd = trimmed.indexOf("。");
  const firstSentence =
    firstSentenceEnd === -1 ? trimmed : trimmed.slice(0, firstSentenceEnd);

  const stripped = stripInstructionSuffixes(stripComparisonClause(firstSentence));

  // 命令句を剥がした結果が空になった場合(入力全体が「調べて」だけ等)
  // は、意味のあるtitleを失わないよう元の文へフォールバックする。
  const candidate = stripped || firstSentence.trim() || trimmed;

  return candidate.length > TITLE_MAX_LENGTH
    ? `${candidate.slice(0, TITLE_MAX_LENGTH)}...`
    : candidate;

}

// =========================
// buildArtifactSectionContent / appendArtifactContent (Phase75)
// =========================
//
// Phase76 Section7により、Artifact MutationはBlock構築
// (classifyArtifactMutation()/buildBlocksForMutation()、本ファイル
// 末尾)へ置き換わった。この2関数はorchestration.tsからはもう
// 呼ばれないが、既存の回帰テスト(tests/tact/artifact/
// tactArtifactMutation.test.ts)がPhase75の挙動として引き続き検証して
// おり、CLAUDE.mdの既存方針により無関係な削除は行わないため、純粋
// 関数のまま残す。
//
// 1回のTurnの成果を、Artifactへ追記する1セクション分のmarkdown
// テキストへ変換する(Section7 Good例と同じ、見出し+本文の形)。

export function buildArtifactSectionContent(
  userInput: string,
  answer: string
): string {

  return `## ${deriveArtifactTitle(userInput)}\n\n${answer.trim()}`;

}

// =========================
// appendArtifactContent
// =========================
//
// Section9絶対条件(既存内容を壊さない): 既存contentを丸ごと置き換え
// ず、末尾に新しいセクションを追記するだけ。初回(既存contentが空)は
// 新セクションがそのまま本文になる。

export function appendArtifactContent(
  existingContent: string,
  newSectionContent: string
): string {

  const trimmedExisting = existingContent.trim();

  if (!trimmedExisting) {
    return newSectionContent.trim();
  }

  return `${trimmedExisting}\n\n${newSectionContent.trim()}`;

}

// =========================
// buildArtifactMutationConfirmation
// =========================
//
// Section7 Good例(「○○についての調査が完了しました。成果物に整理
// しました。」)と同じ形の、簡潔な確認メッセージをConversation側の
// Assistant Messageとして使う。Research/Analysisの詳細本文
// (plan.answer)はここでは使わない——それはArtifact.content側へ渡す
// (buildArtifactSectionContent()、Section7「Bad」を避けるための分離)。

export function buildArtifactMutationConfirmation(
  userInput: string,
  isNewArtifact: boolean
): string {

  const topic = deriveArtifactTitle(userInput);

  return isNewArtifact
    ? `「${topic}」について、成果物に整理しました。右側の成果物をご確認ください。`
    : `「${topic}」について、成果物に反映しました。右側の成果物をご確認ください。`;

}

// =========================
// classifyArtifactMutation (Phase76)
// =========================
//
// detectArtifactMutationIntent()と同じ判定基準を土台に、「更新する/
// しない」の2値ではなく「どの種類のBlockとして反映するか」を決定論的に
// 分類する。
//
// evidence/example/recommendation/hypothesisは、固定フレーズの完全一致
// ではなく「topic語彙(事例/根拠等)とaction語彙(追加/まとめ)の両方が
// 入力中のどこかに含まれるか」で判定する(topic+action co-occurrence)。
// Section16の例「大学生向けの具体例を3つ追加して」のように、名詞と
// 動詞の間に助数詞・助詞が挟まる自然な日本語表現では、固定フレーズの
// 連続一致(「具体例を追加」等)が成立しないため。table/chartは
// 「表にして」「グラフにして」のような既に安定した定型句のため、
// 従来通り固定フレーズ一致のままとする。
//
// いずれのaction語彙("追加"/"まとめ")も、EXPLICIT_MUTATION_PHRASES
// (detectArtifactMutationIntent()が既に真と判定する語彙)の部分文字列
// ("追加して"/"まとめて")を包含する形の入力でのみ実際に一致するため、
// `classifyArtifactMutation(input, capability) !== null` は既存の
// `detectArtifactMutationIntent(input, capability)` と矛盾しない
// (Phase75の回帰テストの結論を壊さない、Section16絶対条件)。
export type ArtifactMutationKind =
  | "research"
  | "chart"
  | "table"
  | "evidence"
  | "example"
  | "recommendation"
  | "hypothesis"
  | "generic";

type SpecificMutationKind = Exclude<ArtifactMutationKind, "research" | "generic">;

interface TopicActionMatcher {
  topics: string[];
  actions: string[];
}

// 判定順序が重要: 複数の種類にマッチしうる場合、より具体的な種類
// (chart/table)を先に確認する。
//
// Phase79 Section9: 「表」という単語を含まない比較指示
// (「○○を比較して」「○○ごとに整理して」)も追加した。「行を○件に
// して」(既存Table行数の調整指示)は数字を含む可変パターンのため、
// ここでは扱わずROW_COUNT_ADJUSTMENT_PATTERN(下記)で別途判定する。
const TABLE_CHART_PHRASES: Record<"chart" | "table", string[]> = {
  chart: ["グラフにして", "グラフ化して"],
  table: ["表にして", "表にまとめ", "比較して", "ごとに整理して"],
};

// 「行を5件にして」「行を3つにして」のような、既存Tableの行数調整
// 指示。TABLE_CHART_PHRASESの固定文字列一致では表現できない
// (数字部分が可変のため)ので正規表現で判定する。
const ROW_COUNT_ADJUSTMENT_PATTERN = /行を\d+(件|つ|個)?に/;

// actionは常に「〜して」という指示形の語尾(Section4「〜について
// 教えて等の単純な質問を誤って対象にしない」と同じ理由で、活用形の
// 語幹だけ("追加"のみ等)には広げない、過去形「追加しました」等を
// 誤検出しないため)。
const TOPIC_ACTION_MATCHERS: Record<
  Exclude<SpecificMutationKind, "chart" | "table">,
  TopicActionMatcher
> = {

  evidence: { topics: ["根拠", "エビデンス"], actions: ["追加して"] },

  example: { topics: ["事例", "具体例"], actions: ["追加して"] },

  recommendation: { topics: ["施策", "提案"], actions: ["追加して", "まとめて"] },

  hypothesis: { topics: ["仮説"], actions: ["追加して", "まとめて"] },

};

const SPECIFIC_KIND_ORDER: SpecificMutationKind[] = [
  "chart",
  "table",
  "evidence",
  "example",
  "recommendation",
  "hypothesis",
];

// Phase80 Section2: 「調査して」と同じメッセージにTable/Chart要求が
// 含まれるかどうかを、Mutation kindの排他分類(classifyArtifactMutation)
// とは独立に判定できるよう、判定ロジック自体を単独の関数として公開する。
// classifyArtifactMutation()がcapability==="research"を最優先する
// 既存の判定順序(Section2「既存のMutation分類を壊さず」)は変更せず、
// この関数はkind===  "research"のケースでも「Table/Chart要求が
// 追加で存在するか」を別途チェックするために
// core/tact-conversation/orchestration.tsから呼ばれる(Phase80)。
export function hasTableIntent(userInput: string): boolean {

  return (
    TABLE_CHART_PHRASES.table.some((phrase) => userInput.includes(phrase)) ||
    ROW_COUNT_ADJUSTMENT_PATTERN.test(userInput)
  );

}

export function hasChartIntent(userInput: string): boolean {

  return TABLE_CHART_PHRASES.chart.some((phrase) => userInput.includes(phrase));

}

function matchesSpecificKind(userInput: string, kind: SpecificMutationKind): boolean {

  if (kind === "chart") {
    return hasChartIntent(userInput);
  }

  if (kind === "table") {
    return hasTableIntent(userInput);
  }

  const matcher = TOPIC_ACTION_MATCHERS[kind];

  return (
    matcher.topics.some((topic) => userInput.includes(topic)) &&
    matcher.actions.some((action) => userInput.includes(action))
  );

}

export function classifyArtifactMutation(
  userInput: string,
  capability: ExecutionCapability
): ArtifactMutationKind | null {

  if (capability === "research") {
    return "research";
  }

  for (const kind of SPECIFIC_KIND_ORDER) {

    if (matchesSpecificKind(userInput, kind)) {
      return kind;
    }

  }

  if (EXPLICIT_MUTATION_PHRASES.some((phrase) => userInput.includes(phrase))) {
    return "generic";
  }

  return null;

}

// =========================
// Research Mutation用Block構築 (Phase76 Section9)
// =========================
//
// Research実行結果からFinding/Evidence Blockを組み立てる。新しいLLM
// 呼び出しは一切行わない——keyFindings/evidenceはいずれもcore/tact-research
// が既に生成済みの値を、core/tact-orchestrator/executor.ts・
// core/tact-conversation/orchestration.tsが素通しした結果を受け取る
// だけ(Repository Evidence: 既存パイプラインで2箇所破棄されていた
// データを配線しただけであり、Research内部ロジックは変更していない)。
//
// keyFindingsが1件も無い場合(core-only経路、またはWeb Researchで
// LLMがkeyFindingsを返さなかった場合——Phase77 Repository Evidence:
// Tavily quota_exceeded等でSearch自体が失敗した実Reality Testで
// 実際に発生することを確認した)は、plan.answer全体を1件の
// Finding Blockとして採用する(Section8「Research結果は必ず何らかの
// 形でArtifactへ整理される」という要求を、Finding不在でも満たすための
// 安全側フォールバック)。
//
// Phase77修正: このコメントが指す挙動をPhase76実装時点では未実装の
// ままにしていたバグ(コメントと実装が乖離していた)を修正した——
// keyFindings=[]の場合、ResearchSummary Blockのみが作られFinding
// Blockが1件も生成されない状態だった。Reality Testで実Search障害時
// (Tavily quota_exceeded等)にFinding不在のArtifactが生成される実害を
// 確認済み(Phase77 Section1・Section8「Raw Data→Finding→Evidence→
// Interpretation→Recommendation」の流れをFinding不在で壊していた)。
export function buildResearchMutationBlocks(
  userInput: string,
  answer: string,
  keyFindings: string[],
  evidence: ResearchEvidenceItem[],
  existingBlocks: ArtifactBlock[]
): ArtifactBlock[] {

  const newBlocks: ArtifactBlock[] = [];
  let order = nextOrder(existingBlocks);

  newBlocks.push(createResearchSummaryBlock(answer, order, deriveArtifactTitle(userInput)));
  order += 1;

  if (keyFindings.length > 0) {

    for (const finding of keyFindings) {
      newBlocks.push(createFindingBlock(finding, order));
      order += 1;
    }

  } else {

    // Phase77修正: keyFindingsが0件でも、answerが空でない限りFinding
    // Blockを1件は残す(上記コメント参照)。answerがそのままFindingの
    // 内容になる(新しい要約・言い換えは行わない、既存answerをそのまま
    // 転記するだけ)。
    if (answer.trim()) {
      newBlocks.push(createFindingBlock(answer.trim(), order));
      order += 1;
    }

  }

  for (const item of evidence) {

    newBlocks.push(
      createEvidenceBlock(
        {
          claim: item.claim,
          source: item.source,
          confidence: item.confidence,
          data: item.snippet,
        },
        order
      )
    );

    order += 1;

  }

  return [...existingBlocks, ...newBlocks];

}

// =========================
// Generic/Example/Recommendation/Hypothesis Mutation用Block構築
// =========================
//
// Table/Chart(既存Blockから決定論的に導出する必要があるため
// core/tact-artifact/blocks.tsのbuildTableFromBlocks()/
// appendRowsToTable()/buildChartFromTable()を直接使う、Section7)を
// 除いた、単純に1つのBlockを追記するだけの種類をここでまとめて扱う。
export function buildSimpleMutationBlock(
  kind: Exclude<ArtifactMutationKind, "research" | "table" | "chart">,
  userInput: string,
  answer: string,
  existingBlocks: ArtifactBlock[]
): ArtifactBlock[] {

  const order = nextOrder(existingBlocks);
  const title = deriveArtifactTitle(userInput);

  const newBlock: ArtifactBlock =
    kind === "example"
      ? createExampleBlock(answer, order, title)
      : kind === "evidence"
        ? createEvidenceBlock({ claim: answer }, order)
        : kind === "recommendation"
          ? createRecommendationBlock(answer, order, title)
          : kind === "hypothesis"
            ? createHypothesisBlock(answer, order, title)
            : createTextBlock(answer, order, title);

  return [...existingBlocks, newBlock];

}

// =========================
// buildExampleMutationBlocks (Phase79 Section5)
// =========================
//
// Root Cause: buildSimpleMutationBlock()の"example"経路(上記)は、
// 「事例を5件追加して」のような複数Entity要求でも常に1件の
// ExampleBlockしか作らず、answer全体をsummaryへ丸ごと格納していた。
// これがComparison Table生成時に「Row Entityが存在しない」状態を
// 生み、Evidence一覧へのフォールバックを引き起こす直接の原因だった。
//
// parseStructuredEntitiesFromText()でanswerが実際に複数のEntityを
// 列挙した構造(Markdown Table/番号付きリスト)になっていると判定
// できた場合のみ、Entityごとに個別のExampleBlock(fields付き、
// Row Entity化)を作る。判定できない場合は既存Phase76〜78の挙動
// (buildSimpleMutationBlock、1件のExampleBlock)にそのまま
// フォールバックする——「分解できないものを無理に分解しない」
// (Section11と同じ精神、新しいLLM呼び出しは追加しない)。
//
// evidenceIds: このTurnで実際に取得されたEvidence(Research経由、
// または直前のSupplemental Research)のidを、生成した全Entityへ
// 一律付与する(Section6「架空の情報を生成してはいけない」の裏返し
// ——行単位の厳密な出典分離は今回のスコープ外、Deferred Decision
// 参照)。
// Phase80: parseStructuredEntitiesFromText()で構造化できたEntityを
// ExampleBlock(fields付き、Row Entity)へ変換して既存blocksへ追記する
// 部分だけを、buildExampleMutationBlocks()から独立した関数として
// 公開する。core/tact-conversation/orchestration.tsのResearch+Table
// 統合(Section2〜4)が、「example」kind専用のbuildExampleMutationBlocks()
// (1件も構造化できない場合はTextBlob化するfallbackを持つ)とは別に、
// 「構造化できればRow Entityを追加、できなければ何もしない」という
// 純粋な追記だけを必要とするため(Research回答にMarkdown Tableが
// 無い場合、Text Blobを作る必要は無い——buildResearchMutationBlocks()
// が既にResearchSummary Blockとしてanswer全文を保持しているため
// 二重に保持しない)。
// =========================
// Evidence Grounding (Phase83 Section2〜4)
// =========================
//
// Root Cause(Phase83投資調査): parseStructuredEntitiesFromText()は
// Research LLMのanswer本文(自由生成テキスト)だけを入力とし、そこに
// 実在するEvidence(検索結果)の内容とは一切照合していなかった。
// RESEARCH_LLM_SYSTEM_PROMPT(core/tact-research/contextAssembly.ts)は
// 「Evidenceに存在しない事実を作らない」よう指示しているが、LLMが
// 指示に従わなかった場合にそれを検出・拒否する仕組みがコード側に
// 存在しなかった——「LLMがそれらしい事例を生成した」ケースと
// 「検索で実際に確認できた事例」のケースを区別できない構造。
//
// 修正方針(絶対条件: 大規模なSchema変更を避け、新しいLLM呼び出しも
// 追加しない): parseStructuredEntitiesFromText()が抽出したEntityを
// Evidence Blockへ渡す前に、Evidenceのclaim/snippet本文に対して
// 決定論的な文字列照合を行う。
//   - Rule4: Entityのtitle(固有名詞)が、少なくとも1件のEvidence本文に
//     明示的に含まれていなければ、そのEntity自体を採用しない
//     (架空の固有名詞をRow Entityへ混入させない)。
//   - Rule3/6: 生き残ったEntityについても、各fieldの値がEvidence本文に
//     見つからない場合は値をそのまま使わず"情報未確認"へ置き換える
//     (「参加しやすい理由」のようなLLMが推測しやすい属性を、
//     Evidence無しでArtifactへ採用しない)。
//   - sourceEvidenceIdsは、そのEntityのtitleを実際に裏付けた
//     Evidenceのidだけにする(Turn全体のEvidenceを一律付与しない、
//     Row単位のTraceabilityを意味のあるものにする)。
//
// 後方互換性: evidencePool未指定(呼び出し元が省略、または
// 既存テストが従来の3引数のまま呼ぶ場合)は、Phase79〜82と全く同じ
// 「parseした全EntityをそのままBlock化し、evidenceIdsを一律付与する」
// 挙動を維持する(Grounding未対応の既存呼び出し元・既存テストを
// 一切壊さない)。
function normalizeForEvidenceMatch(value: string): string {
  return value.replace(/[\s　]+/g, "").toLowerCase();
}

function evidenceTextContains(evidence: ResearchEvidenceItem, needle: string): boolean {

  const normalizedNeedle = normalizeForEvidenceMatch(needle);

  if (!normalizedNeedle) {
    return false;
  }

  const haystack = normalizeForEvidenceMatch(`${evidence.claim} ${evidence.snippet ?? ""}`);

  return haystack.includes(normalizedNeedle);

}

const UNVERIFIED_FIELD_VALUE = "情報未確認";

export interface GroundedEntity {
  entity: ParsedStructuredEntity;
  sourceEvidenceIds: string[];
}

// Phase83 Section11 Test A〜E: parseStructuredEntitiesFromText()の
// 出力とEvidence poolを直接突き合わせて検証できるよう、独立した
// 純粋関数として公開する(新しいLLM呼び出しは発生しない)。
export function groundParsedEntities(
  parsed: ParsedStructuredEntity[],
  evidencePool: ResearchEvidenceItem[]
): GroundedEntity[] {

  const grounded: GroundedEntity[] = [];

  for (const entity of parsed) {

    if (!entity.title.trim()) {
      continue;
    }

    // Rule4: 固有名詞(title)が、少なくとも1件のEvidenceに明示的に
    // 存在すること。存在しなければこのEntity自体を採用しない
    // (架空のEntityを作らない)。
    const matchingEvidenceIds = evidencePool
      .filter((item) => evidenceTextContains(item, entity.title))
      .map((item) => item.id);

    if (matchingEvidenceIds.length === 0) {
      continue;
    }

    // Rule3/6: 各fieldの値も、そのEntityを裏付けたEvidence群の本文に
    // 見つからなければ「情報未確認」へ置き換える(推測・一般論を
    // Evidence無しで採用しない)。
    //
    // Phase90(Structured Research Dataset Section8〜9): 「どのEvidenceが
    // この値を裏付けたか」という判定結果は、Phase83時点では真偽値
    // (supported)としてのみ使い、判定に使ったEvidence id自体は捨てて
    // いた。ここでは新しい検証ロジックを追加せず、既に計算している
    // 判定結果(どのEvidence itemがcontainsチェックを通過したか)を
    // そのままfield.sourceEvidenceIdsとして保持するだけに変更する。
    const groundedFields = entity.fields.map((field) => {

      const supportingEvidenceIds = evidencePool
        .filter(
          (item) =>
            matchingEvidenceIds.includes(item.id) && evidenceTextContains(item, field.value)
        )
        .map((item) => item.id);

      return supportingEvidenceIds.length > 0
        ? { label: field.label, value: field.value, sourceEvidenceIds: supportingEvidenceIds }
        : { label: field.label, value: UNVERIFIED_FIELD_VALUE };

    });

    grounded.push({
      entity: { title: entity.title, fields: groundedFields },
      sourceEvidenceIds: matchingEvidenceIds,
    });

  }

  return grounded;

}

export function appendRowEntitiesFromText(
  existingBlocks: ArtifactBlock[],
  text: string,
  evidenceIds: string[] = [],
  // Phase83: 指定した場合のみEvidence Groundingを適用する(省略時は
  // Phase79〜82と同じ挙動、後方互換)。
  evidencePool?: ResearchEvidenceItem[]
): ArtifactBlock[] {

  const parsed = parseStructuredEntitiesFromText(text);

  if (!parsed || parsed.length === 0) {
    return existingBlocks;
  }

  let order = nextOrder(existingBlocks);

  const candidates: GroundedEntity[] = evidencePool
    ? groundParsedEntities(parsed, evidencePool)
    : parsed.map((entity) => ({ entity, sourceEvidenceIds: evidenceIds }));

  // Phase83 Rule4: Groundingを適用した結果、1件もEvidenceで裏付け
  // られなかった場合は、架空のEntityを作るより何もしない方を選ぶ
  // (既存Blockには一切触れない、no-op)。
  if (evidencePool && candidates.length === 0) {
    return existingBlocks;
  }

  const newBlocks = candidates.map(({ entity, sourceEvidenceIds }) => {

    const summary = entity.fields.map((f) => `${f.label}: ${f.value}`).join(" / ");

    const block = createExampleBlock(
      summary || entity.title,
      order,
      entity.title || undefined,
      entity.fields,
      sourceEvidenceIds.length > 0 ? sourceEvidenceIds : undefined
    );

    order += 1;

    return block;

  });

  return [...existingBlocks, ...newBlocks];

}

export function buildExampleMutationBlocks(
  userInput: string,
  answer: string,
  existingBlocks: ArtifactBlock[],
  evidenceIds: string[] = []
): ArtifactBlock[] {

  const parsed = parseStructuredEntitiesFromText(answer);

  if (!parsed || parsed.length < 2) {
    return buildSimpleMutationBlock("example", userInput, answer, existingBlocks);
  }

  return appendRowEntitiesFromText(existingBlocks, answer, evidenceIds);

}

// =========================
// buildMutationConfirmation (Phase77 Section3)
// =========================
//
// Repository Evidence(Phase77 investigation): orchestration.tsは
// Mutation種別(research/evidence/example/table/chart/recommendation/
// hypothesis/generic)を`classifyArtifactMutation()`で既に判定して
// いたにもかかわらず、Conversation側の応答は種別を無視して常に
// buildArtifactMutationConfirmation()の2パターン(新規/既存)だけを
// 使っていた(Section3で指摘された「何が起きたか分からない」問題の
// 直接の原因)。この関数はkindごとに異なる短文を組み立てる
// (Section3の絶対条件: 詳細はArtifactに集約し、Conversationは
// 1〜2文の報告に留める)。
//
// 捏造防止(Section1「推測値を生成しない」と同じ精神):
// findingCount/evidenceCountはplan.keyFindings.length/plan.evidence.length
// (実際に生成されたBlock数と一致する実データ)のみを使い、
// Section3の例文にある「事例を5件追加しました」のような具体的な
// 件数は、実際にその件数のBlockを生成していない限り書かない
// (Phase76のExample/Evidence等の単純Mutationは1回の呼び出しにつき
// 常に1 Block追加のため、件数を書くと不正確になる——正確性を件数の
// 有無より優先する)。
export interface MutationConfirmationDetail {

  isNewArtifact: boolean;

  // research: 実際に生成されたFinding/Evidence Block数(0でも可)。
  findingCount?: number;

  evidenceCount?: number;

  // table/chart: 実際に何が起きたか。"insufficient_data"の場合、
  // Artifact自体は変更されていない(呼び出し元がMutationを拒否した、
  // Section1)。
  tableStatus?: "created" | "updated" | "insufficient_data";

  chartStatus?: "created" | "updated" | "insufficient_data";

  // Phase79 Section15: Comparison Tableの場合、実際の行数(捏造して
  // いない、実データの件数)とユーザーが要求した件数を両方渡し、
  // 「確認できた3件を整理しました。残り2件は根拠を確認できなかった
  // ため補完していません。」のような、実態と一致する応答を組み立てる。
  tablePurpose?: "comparison" | "evidence";

  tableRowCount?: number;

  tableRequestedRowCount?: number;

}

// Phase80 Section8: 「調査して、表にして」のように同一Turnで
// Research+Table(+Chart)が実行された場合、Conversation応答は
// Research部分の報告だけでなく、実際に追加/更新/見送りされたTable・
// Chartの内容も併せて伝える。既存のcase "table"/"chart"の文言とは
// あえて独立した短文にする(caseの正確な文言はPhase77〜79の既存
// テストが検証しているため変更しない、Section11「既存Evidence
// Traceabilityを壊さない」と同じ精神で既存文言も壊さない)。
function describeTableAddition(detail: MutationConfirmationDetail): string | null {

  if (!detail.tableStatus) {
    return null;
  }

  if (detail.tableStatus === "insufficient_data") {

    return detail.tablePurpose === "comparison"
      ? "比較表にまとめられる根拠付きの事例をまだ十分に確認できなかったため、表の作成は見送りました。"
      : "表にまとめられる根拠のあるデータがまだ十分に確認できなかったため、表の作成は見送りました。";

  }

  if (detail.tablePurpose === "comparison") {

    const rowCount = detail.tableRowCount ?? 0;
    const requested = detail.tableRequestedRowCount;

    if (requested && rowCount < requested) {
      return `確認できた${rowCount}件を比較表に整理しました。残り${requested - rowCount}件は十分な根拠を確認できなかったため、推測で補完していません。`;
    }

    return `確認できた${rowCount}件を比較表に整理しました。`;

  }

  return "確認できた根拠を出典一覧として整理しました。";

}

function describeChartAddition(detail: MutationConfirmationDetail): string | null {

  if (!detail.chartStatus) {
    return null;
  }

  if (detail.chartStatus === "insufficient_data") {
    return "比較可能な根拠付き数値がまだ不足しているため、グラフの作成は見送りました。";
  }

  return "根拠を確認できた数値を比較グラフに整理しました。";

}

export function buildMutationConfirmation(
  kind: ArtifactMutationKind,
  userInput: string,
  detail: MutationConfirmationDetail
): string {

  const topic = deriveArtifactTitle(userInput);

  switch (kind) {

    case "research": {

      const hasFindings = (detail.findingCount ?? 0) > 0;
      const hasEvidence = (detail.evidenceCount ?? 0) > 0;

      const parts: string[] = [];

      if (hasFindings && hasEvidence) {
        parts.push(`「${topic}」について調査しました。発見${detail.findingCount}件・根拠${detail.evidenceCount}件を成果物に整理しています。`);
      } else if (hasFindings) {
        parts.push(`「${topic}」について調査しました。発見${detail.findingCount}件を成果物に整理しています。`);
      } else {
        parts.push(`「${topic}」について調査しました。成果物に整理しています。`);
      }

      // Phase80 Section2〜3: 同一Turnに含まれていたTable/Chart要求の
      // 結果があれば、続けて報告する(Research単独の場合はundefinedの
      // ままなのでdescribeTableAddition/describeChartAdditionはnullを
      // 返し、既存のResearchのみの応答文言は変わらない、Test A)。
      const tableSentence = describeTableAddition(detail);
      if (tableSentence) {
        parts.push(tableSentence);
      }

      const chartSentence = describeChartAddition(detail);
      if (chartSentence) {
        parts.push(chartSentence);
      }

      return parts.join(" ");

    }

    case "evidence":
      return "重要な主張を裏付ける根拠を成果物に追加しました。";

    case "example":
      return `「${topic}」に関する事例を成果物に追加しました。`;

    case "recommendation":
      return "調査結果をもとに、施策を成果物に整理しました。";

    case "hypothesis":
      return "今後検証すべき仮説を成果物に整理しました。";

    case "table": {

      // Phase79 Section15: Comparison Tableの場合、実際の件数と
      // 要求された件数が一致するかどうかで文言を変える(捏造防止の
      // 姿勢をConversation応答自体にも反映する)。
      if (detail.tablePurpose === "comparison" && detail.tableStatus !== "insufficient_data") {

        const rowCount = detail.tableRowCount ?? 0;
        const requested = detail.tableRequestedRowCount;

        if (requested && rowCount < requested) {

          return `確認できた${rowCount}件を比較表に整理しました。残り${requested - rowCount}件は十分な根拠を確認できなかったため、推測で補完していません。`;

        }

        return `${topic}を${rowCount}件、比較表に整理しました。`;

      }

      // Phase78 Section15「根拠を確認できた来場者数を比較表に整理
      // しました。」と同じ、Evidence-Groundedであることが伝わる文言。
      if (detail.tableStatus === "insufficient_data") {
        return "表にまとめられる根拠のあるデータをまだ十分に確認できなかったため、表の作成を見送りました。";
      }

      return detail.tableStatus === "updated"
        ? "根拠を確認できた新しい内容を比較表に追加しました。"
        : "根拠を確認できた内容を比較表に整理しました。";

    }

    case "chart": {

      // Phase78 Section15「根拠の確認できた数値を比較グラフに整理
      // しました。」と同じ文言。
      if (detail.chartStatus === "insufficient_data") {
        return "比較可能な根拠付き数値がまだ不足しているため、グラフの作成を見送りました。";
      }

      return detail.chartStatus === "updated"
        ? "根拠を確認できた数値でグラフを更新しました。"
        : "根拠を確認できた数値を比較グラフに整理しました。";

    }

    case "generic":
    default:
      return buildArtifactMutationConfirmation(userInput, detail.isNewArtifact);

  }

}

// =========================
// classifyTablePurpose (Phase79 Section2・9、Phase85で優先順位を修正)
// =========================
//
// classifyArtifactMutation()がkind==="table"と判定した後、それが
// 「Evidence一覧(出典表)」なのか「Comparison Table(比較表)」なのかを
// 二次分類する。Section2の絶対条件(この2つを絶対に混同しない)への
// 対応。Evidence Table語彙(根拠/エビデンス/出典 + 表/一覧)に一致
// しない場合は既定でcomparisonとする——classifyArtifactMutation()側で
// 既に「表」関連の指示であることは確定済みのため、ここでは
// 「根拠そのものを見せてほしいのか」だけを狭く判定すればよい
// (Section9「根拠を表にして」「出典を一覧にして」「エビデンスを
// 表にして」の3例)。
//
// Root Cause(Phase84投資調査・Phase85修正): 以前はEvidence語彙
// (根拠/エビデンス/出典)とTable語彙(表/一覧)がメッセージ全体の
// どこかに存在するだけでevidenceと判定していた。そのため
// 「イベントを比較表にしてください。各行がどのEvidenceを根拠に
// しているのか追跡できる状態にしてください。」のような、Comparison
// Tableを要求しつつEvidence Traceabilityも求める(=Comparison Table
// の属性・制約であり、Evidence Tableへの変更要求ではない)正当な
// 入力までevidenceへ誤分類され、Comparison Table Builderへ到達
// できなくなっていた(実Reality Testで実際に発生・DB実データで確認)。
//
// 修正: 「比較表」「比較して」「で比較」という明示的なComparison
// トリガー語(Phase79のTABLE_CHART_PHRASES.table「比較して」・
// COMPARISON_TRIGGER_PATTERNの「比較」を再利用、新しい語彙体系は
// 作らない)がメッセージ内のどこかに存在する場合、Evidence関連語が
// 同じ文・別の文のどちらに存在してもcomparisonを優先する
// (Section2の優先順位1〜3「明示的なComparison要求を検出→それを
// 優先→Evidence語が別節にあるだけでは上書きしない」)。Evidence
// Tableは、比較トリガーが一切無く、Evidence語彙+Table語彙のみで
// 構成された入力(「根拠を表にして」「出典を一覧にして」等)にのみ
// 適用される(Section2 Case A/D)。
//
// Phase90(Repository Evidence: Phase89投資調査): 実Reality Testで
// 「参加しやすさを比較できる表にしてください」という言い回しが
// 「比較表」「比較して」「で比較」のいずれにも一致せず、再度evidenceへ
// 誤分類された。「比較」という同一語幹の自然な活用形(比較でき(る)・
// 比較可能・比べられる・比べて)を、無制限な語彙追加ではなく語幹
// ベースで吸収する形に拡張する(「比較」「比べ」という2つの語幹+
// 既存の依頼活用形パターンのみ、Section15「判定する方向を優先」)。
const EXPLICIT_COMPARISON_MARKER_PATTERN =
  /比較表|比較(?:して|でき|可能)|で比較|比べ(?:られ|て)/;

const EVIDENCE_TABLE_TOPIC_WORDS = ["根拠", "エビデンス", "出典"];
const EVIDENCE_TABLE_ACTION_WORDS = ["表", "一覧"];

export function classifyTablePurpose(userInput: string): "evidence" | "comparison" {

  // Phase85優先順位1: 明示的なComparison要求は、Evidence語彙の有無に
  // 関わらず常にcomparisonとして扱う(Section2 Case B/C)。
  if (EXPLICIT_COMPARISON_MARKER_PATTERN.test(userInput)) {
    return "comparison";
  }

  const isEvidenceIntent =
    EVIDENCE_TABLE_TOPIC_WORDS.some((topic) => userInput.includes(topic)) &&
    EVIDENCE_TABLE_ACTION_WORDS.some((action) => userInput.includes(action));

  return isEvidenceIntent ? "evidence" : "comparison";

}

// =========================
// parseComparisonColumns (Phase79 Section3・4)
// =========================
//
// 「イベント名・地域・対象者・特徴・参加しやすい理由の5項目で比較
// 表にして」「◯◯を5件、イベント名・地域・対象者・特徴で比較して」
// のような入力から、ユーザーが明示した比較軸(列名)を抽出する
// (Section4絶対条件: ユーザー指定の列をそのままTable Schemaとして
// 優先し、勝手に「主張・出典・確信度」へ置き換えない)。
//
// 決定論的なheuristicのみ(LLM不使用、Section16「新しいAI編集
// エンジンを作らない」と同じ方針):
//   1. 「で比較」「で整理」「で表に」という指示動詞の直前(最後の
//      出現箇所——長文中の別の節に紛れ込む「で整理」等を避けるため)
//      までを候補segmentとする。
//   2. segment中に「・」「、」「,」の区切り文字が無ければ、単一語
//      (比較軸の列挙ではない、例:「重要度で整理して」)とみなし
//      undefinedを返す。
//   3. 区切り文字で分割した各要素から、列挙に紛れ込みうる無関係な
//      節(「◯◯を5件」等の対象・件数を述べる断片)を、助詞「を」や
//      数詞+助数詞を含む要素を除外することで取り除く(Section4の
//      列そのものは通常、助詞を含まない短い名詞句であるという実務上
//      の傾向に基づく決定論的filter)。
//   4. 除外後に2列以上残った場合のみ、それを比較軸として採用する。
const COMPARISON_TRIGGER_PATTERN = /で(?:比較|整理|表に)/g;
const TRAILING_ITEM_COUNT_PATTERN = /の\d+項目$/;
const COLUMN_NOISE_PATTERN = /(を|\d+(件|個|つ))/;

// segment(句読点で区切られた一文相当のテキスト)から、区切り文字
// (・、,)で列挙された列名候補を抽出する共通部品。同一文内の列指定
// (従来のCase)・直後の文の列指定(Phase91で追加するCase)の両方で
// 同じ抽出・ノイズ除去ルールを使う(責務を分けず、抽出条件だけを
// 共有する)。
function extractColumnsFromSegment(segment: string): string[] | undefined {

  if (!/[・、,]/.test(segment)) {
    return undefined;
  }

  const columns = segment
    .split(/[・、,]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !COLUMN_NOISE_PATTERN.test(c));

  return columns.length >= 2 ? columns : undefined;

}

// Phase91(Repository Evidence: Phase90 Reality Test): 「ここまで調べた
// イベントを、参加しやすさを比較できる表にしてください。列は以下の
// 6項目で整理してください。イベント名、開催日、参加費、対象学年、
// 開催形式、定員。」のように、比較トリガー(「で整理」等)を含む文
// 自体には列挙が無く、その直後の文で初めて列が列挙される言い回しが
// 実Reality Testで確認された(buildResearchTableSchema()がTurn3で
// undefinedを返し、Table-aware Research Promptが一度も発火しなかった
// 直接の原因)。同一文内に列が無い場合に限り、トリガーを含む文の
// 直後の1文だけを追加候補として認識する(過剰な自然言語理解を避ける
// ため、直後の1文に限定し、それ以降の文へは遡らない・LLMは使わない)。
export function parseComparisonColumns(userInput: string): string[] | undefined {

  let lastMatch: RegExpExecArray | null = null;
  let current: RegExpExecArray | null;

  const pattern = new RegExp(COMPARISON_TRIGGER_PATTERN);

  while ((current = pattern.exec(userInput)) !== null) {
    lastMatch = current;
  }

  if (!lastMatch) {
    return undefined;
  }

  const triggerStart = lastMatch.index;
  const triggerEnd = triggerStart + lastMatch[0].length;

  const precedingText = userInput.slice(0, triggerStart);
  const sentenceStart = precedingText.lastIndexOf("。") + 1;

  const sameSentenceSegment = userInput
    .slice(sentenceStart, triggerStart)
    .replace(TRAILING_ITEM_COUNT_PATTERN, "");

  const sameSentenceColumns = extractColumnsFromSegment(sameSentenceSegment);

  if (sameSentenceColumns) {
    return sameSentenceColumns;
  }

  const afterTrigger = userInput.slice(triggerEnd);
  const triggerSentenceEnd = afterTrigger.indexOf("。");

  if (triggerSentenceEnd === -1) {
    return undefined;
  }

  const nextSentenceStart = triggerEnd + triggerSentenceEnd + 1;
  const remainder = userInput.slice(nextSentenceStart);
  const nextSentenceEnd = remainder.indexOf("。");

  const nextSentence = nextSentenceEnd === -1 ? remainder : remainder.slice(0, nextSentenceEnd);

  return extractColumnsFromSegment(nextSentence);

}

// =========================
// parseRequestedRowCount (Phase79 Section7)
// =========================
//
// 「5件」「3件追加して」のような、ユーザーが要求した行(Row Entity)数
// を抽出する。「5項目」(列数、parseComparisonColumns側で処理済み)
// とは助数詞が異なるため混同しない。

const REQUESTED_ROW_COUNT_PATTERN = /(\d+)件/;

export function parseRequestedRowCount(userInput: string): number | undefined {

  const match = userInput.match(REQUESTED_ROW_COUNT_PATTERN);

  if (!match) {
    return undefined;
  }

  const count = Number(match[1]);

  return Number.isFinite(count) && count > 0 ? count : undefined;

}

// =========================
// buildResearchTableSchema (Phase90 Section4〜6)
// =========================
//
// Root Cause(Phase89投資調査): 現在のResearchは「何を埋めるべきか」
// を一切知らないままSearch/LLMを実行し、回答文がたまたま構造化
// されていた場合にのみ後からRow Entity化していた。これを
// 「Research実行前に列構成・要求件数を確定し、Research Promptへ
// 注入する」設計へ寄せるための最小限の合成関数。
//
// 新しいParser/判定ロジックは追加しない——既存のhasTableIntent()・
// classifyTablePurpose()・parseComparisonColumns()・
// parseRequestedRowCount()(いずれもPhase79〜85で確立済み)を、
// Research実行前というこれまでと異なるタイミングで呼び出すだけ。
// ユーザーが比較軸(列)を明示していない場合はundefinedを返し、
// 呼び出し元は既存(Phase79〜89)のResearch後Row Entity化の挙動へ
// そのままフォールバックする(Table Schemaが常に取れるとは限らない、
// 既存の「取れなければ何もしない」という安全側方針を踏襲)。
export interface ResearchTableSchema {
  columns: string[];
  requestedRowCount?: number;
}

export function buildResearchTableSchema(userInput: string): ResearchTableSchema | undefined {

  if (!hasTableIntent(userInput)) {
    return undefined;
  }

  // Evidence Table(「根拠を表にして」等)はEntity/Attribute構造を
  // 前提としないため対象外(Section2既存の使い分けを維持)。
  if (classifyTablePurpose(userInput) !== "comparison") {
    return undefined;
  }

  const columns = parseComparisonColumns(userInput);

  if (!columns || columns.length === 0) {
    return undefined;
  }

  return {
    columns,
    requestedRowCount: parseRequestedRowCount(userInput),
  };

}

// =========================
// parseStructuredEntitiesFromText (Phase79 Section5)
// =========================
//
// Repository Evidence(Root Cause): buildSimpleMutationBlock()の
// "example"経路は、chat capabilityの生回答をまるごと1件のExample
// Blockのsummaryへ格納していた。「5件」という要求があっても、
// 回答が実際に複数のEntityを列挙していれば、それを個別のRow
// Entity(構造化されたExampleBlock、fields付き)へ分解できる余地が
// あるのに活かせていなかった。
//
// ここでは新しいLLM呼び出しを追加せず、既存のchat回答テキストを
// 決定論的に再構造化するだけに留める(Section3「新しいAI編集
// エンジンを作るという意味ではない」)。対応する2つの一般的な
// 出力形式:
//   1. Markdown Table(`| a | b |` ヘッダー + `|---|---|` + データ行)
//      ——「X・Y・Zで整理して」と頼まれたLLMが最も自然に出力しやすい
//      形式。
//   2. 番号付きリスト + インデントされた「ラベル: 値」の子行。
// どちらの形式にも一致しない場合はnullを返す(構造化できないものを
// 無理に分解しない、Section11「捏造しない」の裏返し)。
export interface ParsedStructuredEntity {
  title: string;
  fields: {
    label: string;
    value: string;
    // Phase90: groundParsedEntities()がgrounding後に設定する
    // (field値を実際に裏付けたEvidence id)。parseStructuredEntitiesFromText()
    // 自体はEvidenceを一切参照しないため、生成直後は常にundefined。
    sourceEvidenceIds?: string[];
  }[];
}

function splitMarkdownTableRow(line: string): string[] {

  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");

  return withoutEdges.split("|").map((cell) => cell.trim());

}

const MARKDOWN_TABLE_SEPARATOR_PATTERN = /^\|?[\s:-]+\|[\s:|-]+\|?$/;

function parseMarkdownTable(text: string): ParsedStructuredEntity[] | null {

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = 0; i < lines.length - 1; i++) {

    const headerLine = lines[i];
    const separatorLine = lines[i + 1];

    if (!headerLine.startsWith("|") || !separatorLine.startsWith("|")) {
      continue;
    }

    if (!MARKDOWN_TABLE_SEPARATOR_PATTERN.test(separatorLine)) {
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine);

    if (headers.length < 2) {
      continue;
    }

    const dataRows: string[][] = [];

    for (let j = i + 2; j < lines.length; j++) {

      if (!lines[j].startsWith("|")) {
        break;
      }

      dataRows.push(splitMarkdownTableRow(lines[j]));

    }

    if (dataRows.length === 0) {
      continue;
    }

    return dataRows.map((row) => {

      const fields = headers
        .map((label, idx) => ({ label, value: (row[idx] ?? "").trim() }))
        .filter((field) => field.value.length > 0);

      return { title: (row[0] ?? "").trim(), fields };

    });

  }

  return null;

}

const NUMBERED_ITEM_PATTERN = /^(?:\d+[.、)]|[-*])\s*(.+)$/;
const INLINE_FIELD_PATTERN = /^([^:：]{1,20})[:：]\s*(.+)$/;
const INDENTED_FIELD_LINE_PATTERN = /^\s+[・\-*]?\s*([^:：]{1,20})[:：]\s*(.+)$/;

// 行頭・行末の"**"/"__"等(Markdown強調記号)だけを除去する。文中の
// 記号(例: "A*B")は対象にしない、最小限の見た目クリーンアップ
// (Phase82-B)。
function stripMarkdownEmphasis(value: string): string {
  return value.trim().replace(/^[*_]+|[*_]+$/g, "").trim();
}

// Phase82-B(Repository Evidence: Phase81実DB調査で確認した実障害):
// LLMがよく出力する
//   1. **名古屋マラソン**
//      - **対象者**: 一般
//      - **競技**: マラソン
// という形式(番号付きトップレベル項目 + インデントされたネスト
// 箇条書きfield)に対し、以前はrawLine.trim()してからNUMBERED_ITEM_
// PATTERNを判定していたため、ネストしたfield行("   - **対象者**: 一般")
// もtrim後は"-"始まりとなり、独立した新規トップレベルEntityと誤認
// されていた(親Entityのfieldsが常に空になり、実DBでhas_fields=false
// のBlob ExampleBlockが生成される直接原因になっていた)。
//
// 修正: 行を先にインデント有無で分岐する。インデントされた行は
// 常に「現在のEntityへのfield追加候補」としてのみ扱い、トップレベル
// Entityの開始候補としては一切扱わない(NUMBERED_ITEM_PATTERNを
// 試行しない)。インデントの無い行のみ、従来通りNUMBERED_ITEM_PATTERN
// でトップレベルEntityの開始を判定する。
function parseNumberedFieldList(text: string): ParsedStructuredEntity[] | null {

  const lines = text.split("\n");

  const entities: ParsedStructuredEntity[] = [];
  let current: ParsedStructuredEntity | null = null;

  for (const rawLine of lines) {

    if (!rawLine.trim()) {
      continue;
    }

    const isIndented = /^\s+/.test(rawLine);

    if (isIndented) {

      // インデントされた行は、ネストしたfield行としてのみ解釈する
      // (トップレベルEntityの開始候補にはしない、Phase82-B修正の核心)。
      const fieldMatch = rawLine.match(INDENTED_FIELD_LINE_PATTERN);

      if (fieldMatch && current) {
        current.fields.push({
          label: stripMarkdownEmphasis(fieldMatch[1]),
          value: stripMarkdownEmphasis(fieldMatch[2]),
        });
      }

      continue;

    }

    const itemMatch = rawLine.trim().match(NUMBERED_ITEM_PATTERN);

    if (itemMatch) {

      if (current) {
        entities.push(current);
      }

      const itemText = itemMatch[1].trim();
      const inlineField = itemText.match(INLINE_FIELD_PATTERN);

      current = inlineField
        ? {
            title: stripMarkdownEmphasis(inlineField[2]),
            fields: [{ label: stripMarkdownEmphasis(inlineField[1]), value: stripMarkdownEmphasis(inlineField[2]) }],
          }
        : { title: stripMarkdownEmphasis(itemText), fields: [] };

      continue;

    }

    // インデントも無く番号付きでもない行(プレーンな地の文)は、
    // Entityの一部として取り込まない(既存挙動を維持)。

  }

  if (current) {
    entities.push(current);
  }

  return entities.length >= 2 && entities.every((e) => e.fields.length > 0) ? entities : null;

}

export function parseStructuredEntitiesFromText(text: string): ParsedStructuredEntity[] | null {

  return parseMarkdownTable(text) ?? parseNumberedFieldList(text);

}
