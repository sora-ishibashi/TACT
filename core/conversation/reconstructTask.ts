// =========================
// Task Reconstruction
// =========================
//
// Conversationの「単純追記方式」のcurrentTask更新を、
// LLMによる再構成に置き換えるためのモジュール。
//
// 責務: 会話履歴・現在の成果物(の要約)・直前までの作業状態(currentTask)・
// 最新のユーザー発言を材料に、「このターン終了時点でユーザーが
// 達成したいこと」を1つの自然文(task)として再構成する。
//
// 重要: ここで生成したtaskは、既存Workflow(runWorkflow)へ渡す
// userInputとしてそのまま使われる。Workflow・Agent・Evidence・
// Reviewerの実行方式には一切関与しない。
//
// 失敗時は呼び出し元(core/conversation/index.ts)が
// 既存の単純追記方式へフォールバックする設計とし、
// このモジュール自身はフォールバック処理を持たない
// (例外をthrowするだけ)。

import fs from "fs";
import path from "path";
import { runLLM } from "../llm";
import { Conversation } from "./types";
import { normalizeHeading } from "./mergeWriterOutput";
import { applyRequestTypeSafetyNet } from "./requestTypeGuard";
import { IDEA_MODE_MARKER } from "../workflow/ideaMode";
import {
  buildOutputSpecGuidance,
  OutputSpec,
  resolveOutputSpec,
} from "./outputSpec";

// STEP39: IDEA_MODE_MARKERはcore/workflow/ideaMode.tsで定義する
// (Workflow層。Conversation→Workflowという既存のimport方向を
// 維持するため。core/workflow/runAgent.ts側でも同じ定数を検出に使う)。

// =========================
// Reconstruction結果の内部Schema
// =========================
//
// Workflowへ渡すのは最終的にtask(自然文)のみ。
// 残りのフィールドはログ・検証用の補助情報として保持する。

interface TaskReconstruction {
  task: string;
  latestInstruction: string;
  editIntent: string;
  constraints: string[];
  preserve: string[];
  // STEP17: 今回の指示が「特定の章を対象とする部分的な変更」なのか
  // 「成果物全体を作り直す全面的な変更」なのかを表す。
  // editIntentとは独立したフィールドとして扱う
  // (editIntentは "add|modify|revert|new|clarify" という別の分類軸のため)。
  scope: "targeted" | "full";
  // STEP17: 今回の指示によって直接内容が変更される章の見出し
  // (プレフィックスなし)。実機テストで、preserveに対象章自身が
  // 誤って含まれるケースが確認されたため、preserveだけに頼らず、
  // targetとの差分で保護対象を機械的に確定するための独立フィールド。
  target: string[];
  // STEP28: 今回のユーザー発言が「成果物を変更・生成してほしい依頼
  // (task)」なのか、「既存の成果物・Evidence・Workflow実行過程に
  // ついて説明・評価を求める質問(question)」なのかを表す。
  // "question"の場合、呼び出し元(core/conversation/index.ts)は
  // 通常のWorkflowを起動せず、Advisorへ処理を委譲する。
  requestType: "task" | "question";
  // STEP31: 依頼内容から推定される成果物の型。
  // 新しいAgent・新しいWorkflow分岐は追加せず、Writerへの
  // スタイル指示としてcomposeTask()の合成文へ埋め込むためだけに使う
  // (Writer出力Schema自体は変更しない。sections[].contentの
  // 書き方が変わるだけ)。
  artifactType: "report" | "comparison" | "proposal" | "presentation";
  // STEP39: 今回の発言が「確認済み・調査済みの情報を扱う会話」
  // (evidence)なのか、「まだ正解のない仮説・アイデアを考える会話」
  // (idea)なのかを表す。requestType(task/question)とは独立した軸
  // (直交する概念)であり、requestTypeの判定・分岐ロジックには
  // 一切影響しない。判定に迷う場合は、既存の挙動を変えないよう
  // "evidence"にfallbackする。
  conversationMode: "evidence" | "idea";
}

function cleanJSON(text: string): string {
  return text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

// =========================
// currentOutputの要約
// =========================
//
// currentOutputを丸ごと渡すと無制限に巨大化するため、
// 既存Writer出力Schema(title / sections[].heading)のうち、
// 「今どんな構成の成果物が存在するか」を判断するのに
// 最低限必要なタイトルと各章見出しのみを要約する。
// 本文(content)や証拠(evidenceIds)は含めない。

function summarizeCurrentOutput(currentOutput: unknown): string {

  if (
    !currentOutput ||
    typeof currentOutput !== "object"
  ) {
    return "(現時点で成果物はまだありません。今回が最初の依頼です)";
  }

  const output = currentOutput as Record<string, unknown>;

  const lines: string[] = [];

  if (
    typeof output.title === "string" &&
    output.title.trim()
  ) {
    lines.push(`タイトル: ${output.title}`);
  }

  if (Array.isArray(output.sections)) {

    output.sections.forEach((section, index) => {

      const heading =
        section &&
        typeof section === "object" &&
        typeof (section as Record<string, unknown>).heading === "string"
          ? (section as Record<string, unknown>).heading as string
          : "(見出し未設定)";

      lines.push(`第${index + 1}章: ${heading}`);

    });

  }

  return lines.length > 0
    ? lines.join("\n")
    : "(成果物の構造を認識できませんでした)";

}

// STEP17: 実機テストで、LLMが返すpreserve配列が既存の章見出しを
// 網羅しきれない(一部の章を書き漏らす)ケースが確認された。
// reconcileCurrentOutput()の保護対象は、LLMのpreserve列挙をそのまま
// 信頼するのではなく、conversation.currentOutputの実際の章見出しを
// 直接取得し、target(今回変更される章)との差分として機械的に
// 算出する。preserveフィールド自体は、Writer/Researcherへ見せる
// 文章(composeTask)の材料としては引き続き使う。
function getCurrentHeadings(currentOutput: unknown): string[] {

  if (
    !currentOutput ||
    typeof currentOutput !== "object"
  ) {
    return [];
  }

  const output = currentOutput as Record<string, unknown>;

  if (!Array.isArray(output.sections)) {
    return [];
  }

  return output.sections
    .map((section) =>
      section &&
      typeof section === "object" &&
      typeof (section as Record<string, unknown>).heading === "string"
        ? (section as Record<string, unknown>).heading as string
        : null
    )
    .filter((h): h is string => h !== null);

}

// =========================
// 会話履歴の要約
// =========================
//
// 長大化を避けるため、直近の一定件数のみを渡す。

const MAX_HISTORY_MESSAGES = 20;

function summarizeMessages(conversation: Conversation): string {

  const recent =
    conversation.messages.slice(-MAX_HISTORY_MESSAGES);

  if (recent.length === 0) {
    return "(まだ会話はありません)";
  }

  return recent
    .map(
      (m) =>
        `${m.role === "user" ? "ユーザー" : "TACT"}: ${m.content}`
    )
    .join("\n");

}

// =========================
// 過去のResearch結果の要約 (STEP17)
// =========================
//
// 部分更新(scope: "targeted")の際、Researcherがゼロから全情報を
// 調査し直すことを避けるための参考情報として、直近のWorkflowRunで
// 実際に得られていたResearcherのhandoff(summary/importantPoints)を
// 短く要約する。
//
// 重要: これはWorkflow/Evidenceの実行方式(context.evidenceへの
// 事前投入等)を変更するものではない。あくまでcurrentTask(自然文)へ
// 「既に分かっていること」を書き添え、Researcher/Writerが無駄な
// 再調査をしないよう促す補助情報に留める。強制力は持たない。

const MAX_PAST_RUNS_FOR_FINDINGS = 2;
const MAX_FINDING_POINTS = 6;

function summarizePastFindings(
  conversation: Conversation
): string {

  const recentRuns = conversation.workflowRuns
    .filter((run) => run.status === "completed")
    .slice(-MAX_PAST_RUNS_FOR_FINDINGS);

  const points: string[] = [];

  for (const run of recentRuns) {

    const researcherOutput = run.outputs.researcher as
      | {
          handoff?: {
            summary?: unknown;
            importantPoints?: unknown;
          };
        }
      | undefined;

    const handoff = researcherOutput?.handoff;

    if (!handoff) continue;

    if (
      typeof handoff.summary === "string" &&
      handoff.summary.trim()
    ) {
      points.push(handoff.summary.trim());
    }

    if (Array.isArray(handoff.importantPoints)) {

      handoff.importantPoints
        .filter(
          (p): p is string =>
            typeof p === "string" && p.trim().length > 0
        )
        .forEach((p) => points.push(p.trim()));

    }

  }

  const unique =
    Array.from(new Set(points)).slice(0, MAX_FINDING_POINTS);

  return unique
    .map((p) => `- ${p}`)
    .join("\n");

}

// =========================
// artifactTypeの永続化 (STEP36)
// =========================
//
// 背景: STEP31で導入したartifactTypeは、Turnごとにこの
// モジュール(Task Reconstruction LLM)が毎回ゼロから推定するだけで、
// どこにも永続化されていなかった。全体書き直し(scope: "full")では
// composedTaskから元の文脈が薄れやすく、LLMが安全側の既定値
// "report"へfallbackしてしまうと、既存がcomparison/proposal/
// presentationであっても静かにreportへ変質してしまう問題があった。
//
// 新しいDBテーブル・新しいカラムは追加しない。STEP31の
// EVIDENCE_SNAPSHOT_KEY("__evidence"をrun.outputsへ追加保存する
// 既存の仕組み)と全く同じパターンで、既存のJSONB
// (conversation_workflow_runs.outputs)へもう1つキーを追加するだけ。
export const ARTIFACT_TYPE_SNAPSHOT_KEY = "__artifactType";

function getLastArtifactType(
  conversation: Conversation
): TaskReconstruction["artifactType"] | undefined {

  const recentRuns = conversation.workflowRuns
    .filter((run) => run.status === "completed")
    .slice()
    .reverse();

  for (const run of recentRuns) {

    const value = run.outputs[ARTIFACT_TYPE_SNAPSHOT_KEY];

    if (
      value === "report" ||
      value === "comparison" ||
      value === "proposal" ||
      value === "presentation"
    ) {
      return value;
    }

  }

  return undefined;

}

// =========================
// 元の成果物の文脈保持 (STEP36)
// =========================
//
// 背景: 全体書き直し(scope: "full")の場合、composeTask()は
// (a) preserveが空ならcomposedTaskに元のタイトル・章立てへの
//     言及が一切残らない、(b) pastFindingsSummaryも意図的に
//     省略される、という2重の理由で「何について書いていたか」が
//     Workflow全体(Researcher・Writer含む)から見えなくなっていた。
// STEP33〜35の教訓(Prompt指示だけでは非遵守が起きる)を踏まえ、
// LLMのtask要約に頼らず、conversation.currentOutputという
// 既存データから機械的に「元のテーマ」を抽出し、必ずcomposedTaskへ
// 含める。
//
// 重要: これは「元の章立てを維持せよ」という指示ではない
// (それはSTEP17のpreserve/isFullRewriteの責務のまま変更しない)。
// あくまで「何についての成果物だったか」というテーマ情報を
// 落とさないための追加であり、既存のscope/preserve/isFullRewriteの
// 判定・reconcileCurrentOutput()の挙動には一切影響しない。
function buildOriginalContextBlock(
  currentOutput: unknown,
  originalArtifactType?: TaskReconstruction["artifactType"]
): string {

  if (
    !currentOutput ||
    typeof currentOutput !== "object"
  ) {
    return "";
  }

  const output = currentOutput as Record<string, unknown>;

  const title =
    typeof output.title === "string" &&
    output.title.trim()
      ? output.title.trim()
      : "";

  // タイトルを取得できない場合、何を書いていたかを機械的に
  // 特定できないため、誤った情報を作らず何も追記しない(安全側)。
  if (!title) return "";

  const headings = getCurrentHeadings(currentOutput);

  const lines: string[] = [
    "今回の指示は成果物全体の作り直しですが、以下は元の成果物が" +
    "扱っていたテーマ・目的です。今回のユーザー要求で明示的に" +
    "変更・否定されていない限り、このテーマ自体を無関係な別の" +
    "ものへ変えないでください(対象読者・トーン・章構成など、" +
    "テーマ以外の要素の変更は今回のユーザー要求に従ってください):",
    `- 元のタイトル/テーマ: ${title}`,
  ];

  if (headings.length > 0) {

    lines.push(
      "- 元の章構成(参考情報。この章立てを維持する必要はありません):\n" +
      headings.map((h) => `  - ${h}`).join("\n")
    );

  }

  if (originalArtifactType) {

    lines.push(
      `- 元の成果物タイプ: ${originalArtifactType}` +
      "(ユーザーが明示的に別の形式を求めていない限り、この形式を維持してください)"
    );

  }

  return lines.join("\n");

}

// =========================
// ログ保存
// =========================
//
// core/workflow/runAgent.tsのsaveAgentLog()と同じ考え方で、
// logs/配下に検証用の記録を残す。既存のlogs/運用を変更しない。

function saveReconstructionLog(data: unknown) {

  const logDir =
    path.join(process.cwd(), "logs");

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }

  const fileName =
    `${Date.now()}-taskReconstruction.json`;

  fs.writeFileSync(
    path.join(logDir, fileName),
    JSON.stringify(data, null, 2)
  );

}

const SYSTEM_PROMPT = `
あなたはTACTという複数Agentが協調して成果物を作成するシステムの「作業状態管理者」です。

あなたの役割は、会話履歴・現在の成果物・直前までの作業状態(currentTask)・
最新のユーザー発言をもとに、
「このターン終了時点で、ユーザーは最終的に何を達成したいのか」
を1つの作業指示(task)として再構成することです。

重要な原則:

- 最新のユーザー発言を最優先してください。
- ただし、過去の有効な要求(まだ撤回・変更されていないもの)は保持してください。
- 最新の発言が過去の要求を明示的に撤回・変更している場合は、その要求を除外・修正してください。
- 最新の発言が既存の成果物に対する編集・追加指示である場合は、
  「既存の成果物を維持しながら、次を反映する」という編集意図として整理してください。
- 最新の発言が特定の章(例: 第2章)を指している場合は、現在の成果物の構成を確認し、
  その章が何であるかが分かるように具体的に書いてください
  (例:「第2章」ではなく「第2章『AI教育ツールの特徴と機能』」のように、
  実際の見出し名を含めてください)。
- あなたは実際の成果物(レポート本文など)を書きません。次のWorkflow(Planner以下)へ渡す
  作業指示(task)を整理するだけです。
- taskは日本語の自然な文章で、Plannerがそのまま読んで実行計画を立てられる具体性を
  持たせてください。
- taskには、今回の変更が「成果物全体」に及ぶのか「特定の章」に限定されるのかを
  明記してください。特定の章に限定される場合、それ以外の章には触れないでください。

対象範囲の判断について(特に重要):

- 今回の最新発言がどの範囲に及ぶかは、直前のcurrentTaskがどの章に
  限定されていたかに引きずられず、必ず最新発言そのものの内容から
  独立して判断してください。直前のturnがある章に限定した修正だった
  としても、今回の発言がその章に限定する内容を含まないなら、
  対象範囲を引き継がないでください。
- 文体・トーン・読者層・言葉遣いに関する指示(例:「〜向けの表現にして」
  「もっと分かりやすくして」「フォーマルにして」など、対象章の指定を
  伴わないもの)は、特に章の指定がない限り、成果物全体(すべての章)に
  適用されると解釈してください。この場合、preserveは章立てそのもの
  (どの章も削除・再構成しないこと)を意味し、内容の書き換え自体を
  妨げるものではありません。

具体例(必ずこのパターンに従ってください):

  直前のcurrentTaskが「第2章『AI技術の教育への導入状況』をもっと
  詳しくする」という第2章限定の内容であっても、
  最新発言が「大学生向けの表現にして」のように章の指定を
  含まない場合、正しいtaskは
  「レポート全体の表現を大学生向けに書き換える(第1章・第2章・第3章
  すべてを含む)」であり、
  誤ったtaskは
  「第2章を大学生向けの表現にする」(誤り: 直前の章限定の文脈に
  引きずられて対象範囲を誤って狭めている)です。
  taskの文中に「全体」「すべての章」などの言葉を含めることで、
  範囲が章単位ではなく成果物全体であることを明示してください。

constraintsフィールドについて(特に重要):

- ユーザーが明示的に「〜しないでください」「〜にはしないでください」
  「〜を避けてください」などの形で、特定の結論・表現・考え方を
  禁止または回避するよう求めている場合、その制約は単なる補足情報
  ではなく、今回のタスクの重要な制約として扱ってください。

- 特に、ユーザーが避けるよう名指しした結論・表現は、意味を
  一般化・抽象化・言い換えしすぎず、可能な限り元の表現を保った
  まま constraints に記録してください。

  例:
  - ユーザー:「単に『AもBも重要』という結論にはしないでください」
  - 良い constraints:
    「『AもBも重要』という単純な両論併記の結論にはしない」
  - 避けるべき constraints:
    「一般論ではなく独自の結論を導く」

  後者では、ユーザーが具体的に避けている結論の形が失われています。

- また、ユーザーが「そもそも〜とは何か」「〜の本質は何か」
  「〜とはどういう能力なのか」のように、概念の定義・前提・本質
  そのものを問い直している場合、その問いを単なる「〜の重要性を
  検討する」「〜の価値を考える」のような一般的な目的へ圧縮しないで
  ください。元の問いの構造を可能な限り維持し、後続Agentがその
  問い自体を検討できる形で task または constraints に残して
  ください。

保持すべき情報の優先順位:

以下の情報は、要約時に削除・一般化しないでください。

  1. ユーザーが明示的に禁止・回避した結論や表現
  2. ユーザーが定義・本質・前提そのものを問い直している発言
  3. ユーザーが明示的に求めている対立・比較・条件
  4. ユーザーが明示的に求めている独自の結論・仮説

これらは、後続Agentの判断や結論を直接制約する情報です。

preserveフィールドについて(特に重要):

- preserveは「内容を一切変更しない」という意味ではなく、
  「章立て(見出し)自体を壊さない」という意味です。
- preserveには、現在の成果物に既に存在する章見出し(タイトルを含む)を、
  ユーザーが明示的に削除・撤回を指示したものを除き、すべて列挙してください。
  - 特定の章だけを詳細化・修正する指示の場合も、それ以外の既存の章の見出しを
    すべてpreserveに含めてください(そのうえで、それらの章の内容自体は
    変更しないでください)。
  - 文体・トーン・読者層など成果物全体に及ぶ指示の場合も、既存の章見出しを
    すべてpreserveに含めてください(この場合、各章の内容自体は指示に沿って
    更新して構いません。preserveは章立てを保つことだけを意味します)。
- これはこの後の情報収集(Researcher)や執筆(Writer)が、無関係な章まで
  作り直してしまったり、既存の章を欠落させてしまったりすることを防ぐための
  重要な情報です。
- 現在の成果物がまだ存在しない場合は、preserveは空配列にしてください。

scopeフィールドについて(特に重要):

- scopeは、今回の指示が「特定の章を対象とする部分的な変更」なのか
  「成果物全体を作り直す全面的な変更」なのかを表します。
- 次のような、既存の構成そのものを作り直す・見直す意図が明確な指示の
  場合は scope: "full" としてください:
  例:「全体を書き直して」「構成を変更して」「全章を見直して」
  「章立てから作り直して」「最初から作り直して」など。
- それ以外(特定の章の詳細化・追加・修正、複数章にまたがるが既存の
  章立て自体は維持する指示、文体・トーンなど全体に及ぶが章立ては
  変えない指示など)は scope: "targeted" としてください。
- 現在の成果物がまだ存在しない場合(今回が最初の依頼)は
  scope: "full" としてください。
- scope: "full" の場合でも、preserveフィールドには従来どおり
  変更前に存在していた章見出しを列挙してください
  (scopeの判定とpreserveの列挙は別の情報です。scope側で
  全面変更が許可されているかどうかを判断します)。

targetフィールドについて(特に重要):

- targetは、今回の指示によって直接内容が変更される章の見出しを、
  「第N章」等のプレフィックスを付けず、現在の成果物の見出しの
  文言のみで列挙するフィールドです。
- 例えば現在の成果物に「第3章: 学生によるAIツールの利用状況と
  倫理的課題」が存在し、今回の指示が「第3章を詳しくして」で
  あれば、target は ["学生によるAIツールの利用状況と倫理的課題"]
  としてください。
- 複数章にまたがる指示の場合は、対象となる章の見出しをすべて
  列挙してください。
- 対象章を特定できない場合(scope: "full"の場合、成果物がまだ
  存在しない場合、章単位でない全体的な指示の場合など)は、
  空配列にしてください。
- 重要: targetに含めた見出しは、preserveには含めないでください。
  preserveは「今回変更しない章」、targetは「今回変更する章」であり、
  同じ章が両方に含まれることは矛盾です。

requestTypeフィールドについて(特に重要):

- requestTypeは、今回の最新発言が
  「成果物を変更・生成してほしい依頼」なのか、
  「既存の成果物・Evidence・Workflow実行過程についての説明・評価を
  求める質問」なのかを判定するフィールドです。

- 次のような、成果物の内容そのものを変更・追加・書き直すことを
  求める発言は requestType: "task" としてください。
  例:「第3章を詳しくして」「最新の情報を追加して」
  「全体を書き直して」「弱いところを直して」
  「第2章の内容を変更して」

- 次のような、既存の成果物・Evidence・Workflow実行過程についての
  説明・評価・根拠提示を求める発言は requestType: "question" と
  してください。
  例:「この成果物について説明して」「このレポートの要点は？」
  「この成果物は信用度高い？」「この数字はどこから来た？」
  「この章はなぜこう書かれている？」「どこが一番弱い？」
  「どの部分にEvidenceがあるか」「今回どこを変更した？」
  「このレポートの弱いところを教えて」(直すことを求めていない場合)
  「この数字の一次情報源URLを教えて」「出典URLは？」
  「一次情報を見せて」(成果物への追記を求めていない場合)

- 重要: 「教えて」「見せて」「〜は？」という言い回しは、
  「ユーザーが今、口頭(チャット)で答えを知りたい」という意味であり、
  「その情報を成果物本文に追記・修正してほしい」という意味では
  ありません。「一次情報源URLを教えて」「出典を教えて」のような
  発言は、URLや出典を成果物に追加する指示ではなく、Advisorが
  チャット上で回答すべき質問(question)です。
  「〜を本文に追加して」「〜を明記して」のように、成果物そのものを
  書き換える意図が明確な場合のみtaskとしてください。

- 誤りやすいパターン(必ず注意してください):
  「この数字の一次情報源URLを教えて」という発言を見て、
  「URLを取得して成果物に追加する作業(task)」と解釈するのは
  誤りです。この発言はあくまで「教えて」(=今すぐ口頭で知りたい)
  であり、成果物を編集してほしいとは一言も言っていません。
  正しくは requestType: "question" です。
  直前のturnで章の編集(task)を行っていたとしても、それに
  引きずられて次の発言も自動的にtaskだと判断しないでください。
  発言ごとに独立して判断してください。

- 判断基準は「変更/生成を求めているか」「説明/評価を求めているか」です。
  同じ話題(例: 弱点)であっても、「教えて」「どこ？」「なぜ？」の
  ように説明・評価を求める言い回しなら question、
  「直して」「書き直して」「追加して」「変更して」のように
  成果物そのものへの変更を求める言い回しなら task としてください。

- 章を指定した発言でも、判断基準は同じです。
  「第2章を説明して」「第2章の内容を教えて」は question ですが、
  「第2章を修正して」「第2章をもっと具体的にして」は task です。
  「この成果物の目的を説明してください」のように、対象が
  (成果物全体・特定の章・特定の表・特定の数値のいずれであっても)
  「説明して」「教えて」で終わる発言は、原則として question です。
  「〜の章を追加して」「〜を目的の章にして」のように、対象を
  作る・変える動詞が付く場合のみ task としてください。

- 現在の成果物がまだ存在しない場合は、質問できる対象が存在しないため、
  常に requestType: "task" としてください。

artifactTypeフィールドについて(特に重要):

- artifactTypeは、依頼内容から自然に想定される成果物の型を表します。
  以下の4種類から選んでください。

  "report"(通常の調査レポート):
    上記以外の、一般的な調査・説明・まとめを求める依頼。
    迷った場合はこれを選んでください。

  "comparison"(複数対象の比較):
    例:「OpenAI、Google、AnthropicのAI戦略を比較して」
    「競合3社を比較して」「A案とB案どちらが良いか整理して」
    「メリット・デメリットを比較して」「この3社を表にして」

  "proposal"(企画書・提案書):
    例:「大学生向けの企画書を作って」
    「大学生向けAIサービスの企画書を作って」
    「新しいサービスを企画して」

  "presentation"(プレゼンテーション資料の構成):
    例:「この内容をプレゼン資料の構成にして」
    「今回の調査結果をプレゼン資料の構成にして」

- 部分更新(第2章を詳しくして、等)の場合は、既存の成果物が既に
  どの型に近いかを踏まえて判定してください(新規判定に迷う場合は
  現在の成果物の構成から推測して構いません)。
- requestType: "question"の場合、artifactTypeは現在の成果物の型を
  そのまま維持する形で構いません(判定に迷う場合は"report")。

conversationModeフィールドについて(特に重要):

- conversationModeは、requestType(task/question)とは全く別の軸
  です。混同しないでください。requestTypeは「成果物を変更したい
  のか、成果物について質問したいのか」、conversationModeは
  「確認済みの情報を扱う会話なのか、まだ正解のない仮説・アイデアを
  考える会話なのか」を表します。

- 次のような、事実確認・調査結果の整理・既存Evidenceに基づく
  記述を求める発言は conversationMode: "evidence" としてください。
  例:「この市場規模を調べて」「この数字はどこから来た？」
  「最新の情報を追加して」「このデータをまとめて」

- 次のような、まだ答えのない仮説・アイデア・方向性・改善案を
  考えたい発言は conversationMode: "idea" としてください。
  例:「新規事業のアイデアを考えて」「このアイデアどう思う？」
  「別の方向性を3つ考えて」「もっと面白くするなら？」
  「この企画について別の方向性を考えて」
  「この案の弱点から改善案を考えて」

- STEP40: アイデア・仮説の「妥当性・需要・実現可能性」を確認・
  検証したい発言は、"アイデア"という言葉を含んでいても
  conversationMode: "evidence" としてください
  (考える段階ではなく、事実を確認したい段階のため)。
  例:「このアイデア、本当に需要ある？」「市場規模はどれくらい？」
  「競合はいる？」「実際にこういうサービスある？」
  「この仮説をデータで検証して」「この数字って本当？」

- STEP40: 調査結果・データをもとに、次のアイデア・方向性・企画を
  考えたい発言も conversationMode: "idea" としてください。
  例:「この結果を踏まえて別案を考えて」
  「このデータから新しい事業を考えて」
  「この市場ならどんなサービスがありそう？」
  「競合が強いなら別の方向性を考えよう」
  「この調査結果から企画を作り直したい」

- 「調べて」「最新」など、外部の事実確認を明確に求める語彙が
  伴う場合はideaであってもevidenceを優先してください
  (例:「この市場について調べた上で新規事業を3案考えて」は、
  調査部分がある以上 "evidence" としてください。ただしこれは
  Researcherの検索要否判定自体を変えるものではなく、あくまで
  conversationModeという表示用の分類です)。

- 判定に迷う場合、または現在の成果物の更新・追記など通常の作業
  依頼である場合は "evidence" としてください
  (既存の挙動を変えないための安全側のfallback)。

出力は指定されたJSON形式のみとし、それ以外の説明文を含めないでください。
`.trim();

function buildUserPrompt(
  previousTask: string,
  currentOutputSummary: string,
  messageHistory: string,
  latestUserInput: string
): string {

  return `
========================
過去の作業状態(currentTask)
========================
${previousTask || "(まだありません。今回が最初の依頼です)"}

========================
現在の成果物の構造
========================
${currentOutputSummary}

========================
これまでの会話
========================
${messageHistory}

========================
最新のユーザー発言
========================
${latestUserInput}

========================
出力フォーマット(JSON)
========================
{
  "task": "Plannerへ渡す、このターン終了時点でユーザーが達成したいことの全体像(自然文)",
  "latestInstruction": "最新のユーザー発言の要点",
  "editIntent": "add | modify | revert | new | clarify のいずれか",
  "constraints": ["今回の作業で維持すべき制約や条件"],
  "preserve": ["既存の成果物のうち、変更せず維持すべき要素"],
  "scope": "targeted | full のいずれか",
  "target": ["今回内容が変更される章の見出し(プレフィックスなし)"],
  "requestType": "task | question のいずれか",
  "artifactType": "report | comparison | proposal | presentation のいずれか",
  "conversationMode": "evidence | idea のいずれか"
}
`.trim();

}

// =========================
// composeTask
// =========================
//
// LLMが返したtask(自然文の要約)に、preserve/constraintsを
// 明示的に埋め込んだ最終的なcurrentTask文字列を組み立てる。
//
// taskだけをそのままcurrentTaskとして使うと、preserve/constraintsが
// Workflow側(特にcurrentOutputを受け取らないResearcher等)に一切
// 伝わらず、既存の章立てを無視した無関係な情報収集・全面書き換えを
// 誘発する恐れがあるため、必ず1本のcurrentTask文字列にまとめて渡す。

function composeTask(
  parsed: TaskReconstruction,
  pastFindingsSummary: string,
  // STEP36: 全体書き直し時に元のテーマ・目的を保持するための
  // 追加パラメータ。両方ともisFullRewrite === trueの場合にのみ
  // 使用する(部分更新の既存挙動には一切影響しない)。
  currentOutput?: unknown,
  originalArtifactType?: TaskReconstruction["artifactType"],
  // STEP51: Writerへ「どれくらいの粒度で成果物を作るか」を伝える
  // Output Specの指示文。artifactStyleGuidanceと同じく、
  // composedTask文字列へ追記するだけで、Writer出力Schema
  // (core/prompt/outputFormats.ts)自体は変更しない。
  outputSpecGuidance?: string
): string {

  const parts: string[] = [
    parsed.task.trim(),
  ];

  const isFullRewrite = parsed.scope === "full";

  // STEP36: LLMのtask要約が元のテーマに触れなかった場合の
  // 構造的な安全網。parsed.preserveの有無に関わらず、
  // isFullRewriteの場合は常にこのブロックを追加する
  // (STEP17のpreserve/isFullRewriteの判定自体は変更しない)。
  if (isFullRewrite) {

    const originalContextBlock =
      buildOriginalContextBlock(
        currentOutput,
        originalArtifactType
      );

    if (originalContextBlock) {
      parts.push(originalContextBlock);
    }

  }

  if (
    Array.isArray(parsed.preserve) &&
    parsed.preserve.length > 0
  ) {

    if (isFullRewrite) {

      // STEP17: 「全体を書き直して」等、明確に全面更新が要求されて
      // いる場合は、既存の章立てを維持する制約を課さない。
      parts.push(
        "今回の指示は成果物全体の構成を作り直すことを明確に求めて" +
        "います。以下は変更前に存在していた章立てですが、維持を強制" +
        "するものではありません。今回の指示に沿って章立て自体を" +
        "変更・再構成して構いません:\n" +
        parsed.preserve
          .map((p) => `- ${p}`)
          .join("\n")
      );

    } else {

      parts.push(
        "現在の成果物に既に存在する章立て(見出しを削除したり無関係な" +
        "章に置き換えたりしないこと。今回の指示が特定の章のみを" +
        "対象とする場合、それ以外の章の内容は変更しない。今回の指示が" +
        "成果物全体に及ぶ場合は、章立てを維持したまま各章の内容を更新する):\n" +
        parsed.preserve
          .map((p) => `- ${p}`)
          .join("\n")
      );

    }

  }

  if (
    Array.isArray(parsed.constraints) &&
    parsed.constraints.length > 0
  ) {

    parts.push(
      "満たすべき制約:\n" +
      parsed.constraints
        .map((c) => `- ${c}`)
        .join("\n")
    );

  }

  // STEP17: 部分更新の場合のみ、既に収集済みの情報を参考として
  // 付記する。ゼロからの再調査を避け、今回の指示にとって本当に
  // 不足している情報だけを追加調査するよう促す(強制ではない)。
  if (!isFullRewrite && pastFindingsSummary) {

    parts.push(
      "既に収集済みの主な情報(重複調査を避けるための参考です。" +
      "今回の指示に照らして新しい情報・根拠が必要な場合は、" +
      "それを優先して追加調査してください):\n" +
      pastFindingsSummary
    );

  }

  // STEP31: 成果物の型に応じたスタイル指示。
  // 新しいAgent・新しいWriter出力Schemaは作らず、既存のsections[].
  // headingとcontentの「書き方」だけを型に応じて変える。
  // "report"(通常レポート)の場合は従来どおり何も付記しない
  // (既存の挙動を一切変えないため)。
  const artifactStyleGuidance =
    buildArtifactStyleGuidance(parsed.artifactType);

  if (artifactStyleGuidance) {
    parts.push(artifactStyleGuidance);
  }

  // STEP51: Output Spec(出力量の目安)。artifactStyleGuidanceと
  // 同じ位置づけで、composedTask文字列(=Workflowへ渡すuserInput/task)
  // へ追記する。新しいAgent・新しいWorkflow分岐は追加しない。
  if (outputSpecGuidance) {
    parts.push(outputSpecGuidance);
  }

  // STEP39: Idea Mode。IDEA_MODE_MARKERを含めることで、
  // core/workflow/runAgent.ts側がcontext.userInput(=この
  // composedTask)から検出できるようにする。Researcherの検索要否
  // 判定(core/evidence/researchRequirement.ts)は変更しないため、
  // Idea Modeであること自体が検索の要否を左右することはない。
  if (parsed.conversationMode === "idea") {

    parts.push(
      IDEA_MODE_MARKER + "\n\n" +
      "この会話ではEvidence(調査済みの事実)が不足していること" +
      "自体は問題ではありません。断定できる根拠がない場合でも、" +
      "既存の知識・推論をもとに仮説やアイデアを提示してください" +
      "(ただしEvidenceに反する事実を作ってはいけません)。"
    );

  }

  return parts.join("\n\n");

}

// =========================
// buildArtifactStyleGuidance (STEP31)
// =========================
//
// 成果物の型(artifactType)に応じて、Writerが各章(sections[].content)を
// どう書くべきかのスタイル指示を1つの文字列として組み立てる。
// Writer出力Schema(outputFormats.writer)自体は変更しない
// (contentは引き続きただの文字列。表・箇条書きもすべてこの
// 文字列の中に書く)。
//
// "report"の場合は空文字列を返し、composeTask()側で何も追記しない
// (既存の挙動を一切変えないため)。

function buildArtifactStyleGuidance(
  artifactType: TaskReconstruction["artifactType"]
): string {

  switch (artifactType) {

    case "comparison":

      return (
        "この依頼は複数の対象を比較する成果物(Comparison)です。" +
        "可能な限り、比較対象を扱う章の内容(content)にMarkdown表" +
        "(例:\n| 比較項目 | 対象A | 対象B |\n| --- | --- | --- |\n" +
        "| 強み | ... | ... |\n)を用いて、比較項目ごとに整理して" +
        "ください。表だけで終わらせず、表から読み取れる結論・示唆を" +
        "文章で添えてください。単なる文章の羅列で済ませないでください。" +
        // STEP38: 構造(表を使うこと)だけでなく、比較としての
        // 完成度も明示する。
        "比較軸(何を基準に比較しているか)を明確にし、対象ごとの" +
        "紹介を並べるだけの成果物にしないでください。対象間の差分・" +
        "共通点が読み手に伝わることを重視してください。"
      );

    case "proposal":

      return (
        "この依頼は企画書・提案書(Proposal)です。背景/課題、" +
        "ターゲット、目的、アイデア/施策、実行方法、KPI、リスク、" +
        "Next Actionなど、企画書として自然な構成の章立てにして" +
        "ください。ただし、これらの項目をすべて機械的に含める必要は" +
        "なく、依頼内容に応じて過不足なく調整してください。" +
        // STEP38: 「提案しっぱなし」で終わらせない。
        "課題・背景から提案内容への論理的なつながりを明確にし、" +
        "「こうしたらいい」という提案だけで終わらせず、誰が・何を・" +
        "どう進めるかが分かる、実行可能性のある内容にしてください。"
      );

    case "presentation":

      return (
        "この依頼はプレゼンテーション資料の構成(Presentation)です。" +
        "各章の見出しを「Slide 1: タイトル」のような形式にし、" +
        "内容(content)は長い説明文ではなく、簡潔な要点を箇条書き" +
        "(・や-で始まる短い行を改行で並べる形)で示してください。" +
        // STEP38: 単なる「レポートの章をSlideに置き換えただけ」を防ぐ。
        "1スライドにつき伝えたいメッセージは1つに絞り、聴衆にとって" +
        "重要度の低い情報は削るか他スライドへ統合してください。" +
        "各スライドの見出し(タイトル行)だけを順に読んでも、" +
        "全体のストーリー(流れ)が伝わるように見出しを具体的に" +
        "書いてください(「概要」のような抽象的な見出しを避ける)。"
      );

    default:

      return "";

  }

}

// =========================
// reconstructCurrentTask
// =========================
//
// 成功時: 再構成結果(composedTask文字列 + STEP17で追加した
// preserveHeadings/isFullRewrite)を返す。
// 失敗時: 例外をthrowする(フォールバックは呼び出し元の責務)。

export interface TaskReconstructionResult {

  // Workflow(runWorkflow)へそのまま渡す、これまでどおりの
  // 合成済みcurrentTask文字列。
  composedTask: string;

  // STEP17: 今回変更してはいけない(維持すべき)章見出し。
  // Task Reconstructionでpreserveを特定できなかった場合は空配列。
  preserveHeadings: string[];

  // STEP17: ユーザーが全面的な作り直しを明確に求めているかどうか。
  // trueの場合、preserveHeadingsによる保護は適用しない
  // (呼び出し元・reconcileCurrentOutput()側の判断材料)。
  isFullRewrite: boolean;

  // STEP28: 今回のユーザー発言が成果物の変更・生成を求める依頼
  // (task)か、既存の成果物等について説明・評価を求める質問
  // (question)かを表す。呼び出し元(runConversationTurn)が
  // Workflow起動かAdvisor委譲かを判断するために使う。
  requestType: "task" | "question";

  // STEP31: 依頼内容から推定される成果物の型。composedTask文字列に
  // 既にスタイル指示として埋め込み済みのため、Workflow自体は
  // このフィールドを直接参照しない。将来的な用途
  // (UI表示・Advisorでの参照等)のために構造化した値としても返す。
  artifactType: "report" | "comparison" | "proposal" | "presentation";

  // STEP39: requestTypeとは独立した軸。composedTask文字列に
  // 既にIDEA_MODE_MARKERとして埋め込み済み。呼び出し元
  // (core/conversation/index.ts)がAdvisorへ渡すため、および
  // ログ用に構造化した値としても返す。
  conversationMode: "evidence" | "idea";

  // STEP51: Writerへ「どれくらいの粒度で成果物を作るか」を伝える
  // 内部設定。composedTask文字列に既にPrompt指示として埋め込み
  // 済みのため、Workflow自体はこのフィールドを直接参照しない。
  // artifactType/conversationModeと同じく、将来的な用途
  // (UI表示・ログ参照等)のために構造化した値としても返す。
  outputSpec: OutputSpec;

}

export async function reconstructCurrentTask(
  conversation: Conversation,
  userInput: string,
  // STEP52: mode(quick/think/deep)をOutputSpecのdetailLevel決定に
  // 補助的な影響として使うため受け取る。省略時は既存呼び出しと
  // 同じ既定値("think")を使い、既存の挙動を変えない。
  mode: "quick" | "think" | "deep" = "think"
): Promise<TaskReconstructionResult> {

  const previousTask = conversation.currentTask;

  const currentOutputSummary =
    summarizeCurrentOutput(conversation.currentOutput);

  const messageHistory =
    summarizeMessages(conversation);

  const userPrompt = buildUserPrompt(
    previousTask,
    currentOutputSummary,
    messageHistory,
    userInput
  );

  const response = await runLLM({

    provider: "openai",

    systemPrompt: SYSTEM_PROMPT,

    userPrompt,

  });

  const cleaned = cleanJSON(response.content ?? "");

  if (!cleaned) {

    saveReconstructionLog({
      previousTask,
      userInput,
      currentOutputSummary,
      messageHistory,
      status: "failed",
      error: "empty response",
    });

    throw new Error(
      "Task reconstruction returned empty response."
    );

  }

  let parsed: Partial<TaskReconstruction>;

  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    saveReconstructionLog({
      previousTask,
      userInput,
      currentOutputSummary,
      messageHistory,
      status: "failed",
      rawResponse: response.content,
      error: String(error),
    });

    throw error;

  }

  if (
    typeof parsed.task !== "string" ||
    !parsed.task.trim()
  ) {

    saveReconstructionLog({
      previousTask,
      userInput,
      currentOutputSummary,
      messageHistory,
      status: "failed",
      rawResponse: response.content,
      error: "task field missing or empty",
    });

    throw new Error(
      "Task reconstruction did not return a valid task string."
    );

  }

  // STEP36: 前回までのTurnで実際に使われていたartifactType
  // (存在すれば)。run.outputs[ARTIFACT_TYPE_SNAPSHOT_KEY]から
  // 復元する(STEP31のEVIDENCE_SNAPSHOT_KEYと同じ仕組み)。
  const originalArtifactType =
    getLastArtifactType(conversation);

  // STEP37: requestType安全網。
  // LLMが返したrequestType(不正値の場合はtaskへfallback、既存の
  // STEP28ロジックと同じ)に対し、今回のユーザー発言(userInput、
  // 会話履歴には依存しない)だけを見て、質問/作業依頼のどちらかを
  // 示す語彙が一方的に現れる場合のみ補正する。新しいLLM呼び出しは
  // 追加しない。
  const rawRequestType: "task" | "question" =
    parsed.requestType === "task" ||
    parsed.requestType === "question"
      ? parsed.requestType
      : "task";

  const guardedRequestType =
    applyRequestTypeSafetyNet(
      userInput,
      rawRequestType
    );

  const normalized: TaskReconstruction = {

    task: parsed.task.trim(),

    latestInstruction:
      typeof parsed.latestInstruction === "string"
        ? parsed.latestInstruction
        : userInput,

    editIntent:
      typeof parsed.editIntent === "string"
        ? parsed.editIntent
        : "unknown",

    constraints:
      Array.isArray(parsed.constraints)
        ? parsed.constraints.filter(
            (c): c is string => typeof c === "string"
          )
        : [],

    preserve:
      Array.isArray(parsed.preserve)
        ? parsed.preserve.filter(
            (p): p is string => typeof p === "string"
          )
        : [],

    // STEP17: LLMがscopeを返さなかった/不正な値の場合の既定値。
    // 既存の成果物がまだ無ければ"full"(初回生成なので全面が自然)、
    // 既にあれば"targeted"(従来のpreserve保護寄りの安全側)とする。
    scope:
      parsed.scope === "full" || parsed.scope === "targeted"
        ? parsed.scope
        : conversation.currentOutput
          ? "targeted"
          : "full",

    target:
      Array.isArray(parsed.target)
        ? parsed.target.filter(
            (t): t is string => typeof t === "string"
          )
        : [],

    // STEP28: 成果物がまだ存在しない場合は、質問できる対象が
    // 存在しないため常にtask。
    // STEP37: 成果物が存在する場合は、LLMの生の判定(rawRequestType)
    // ではなく、requestTypeGuard.tsで機械的に補正した
    // guardedRequestTypeを採用する。
    requestType:
      conversation.currentOutput
        ? guardedRequestType
        : "task",

    // STEP31: LLMがartifactTypeを返さなかった/不正な値の場合は
    // "report"(従来どおりの通常レポート)にfallbackする
    // (=artifactType追加によって既存の挙動が変わらないようにする)。
    artifactType:
      parsed.artifactType === "comparison" ||
      parsed.artifactType === "proposal" ||
      parsed.artifactType === "presentation" ||
      parsed.artifactType === "report"
        ? parsed.artifactType
        : "report",

    // STEP39: LLMがconversationModeを返さなかった/不正な値の場合は
    // "evidence"(従来どおりの挙動)にfallbackする
    // (=conversationMode追加によって既存の挙動が変わらないようにする)。
    conversationMode:
      parsed.conversationMode === "idea"
        ? "idea"
        : "evidence",

  };

  const isFullRewrite = normalized.scope === "full";

  // STEP36: 全体書き直しで、今回のLLM判定が既定値"report"へ
  // fallbackしており(=parsed.artifactTypeが未指定/不正だった、
  // または本当にreportと判定された、のいずれかで区別がつかない)、
  // かつ元の成果物が"report"以外の型だった場合は、文脈喪失による
  // fallbackの可能性が高いと判断し、元の型を維持する。
  // LLMが"comparison"等、report以外の具体的な型を返した場合は、
  // ユーザーが明示的にその型を求めた可能性が高いため、その判定を
  // そのまま信頼する(=このブロックは介入しない)。
  if (
    isFullRewrite &&
    originalArtifactType &&
    originalArtifactType !== "report" &&
    normalized.artifactType === "report"
  ) {
    normalized.artifactType = originalArtifactType;
  }

  const pastFindingsSummary = isFullRewrite
    ? ""
    : summarizePastFindings(conversation);

  // STEP51/52: ユーザー明示指定 > artifactType既定値(mode補正込み)
  // > TACT既定、の優先順位でOutput Specを決定する(outputSpec.ts
  // 参照)。新しいLLM呼び出しは追加せず、既に確定したartifactTypeと
  // 最新のユーザー発言(userInput)・mode引数だけから決定的に計算する。
  const outputSpec = resolveOutputSpec(
    userInput,
    normalized.artifactType,
    mode
  );

  const outputSpecGuidance = buildOutputSpecGuidance(outputSpec);

  const composedTask = composeTask(
    normalized,
    pastFindingsSummary,
    conversation.currentOutput,
    originalArtifactType,
    outputSpecGuidance
  );

  // STEP17: reconcileCurrentOutput()へ渡す保護対象(preserveHeadings)は、
  // LLMのpreserve列挙(書き漏らしがあり得る)ではなく、
  // conversation.currentOutputの実際の章見出し一覧から、
  // target(今回変更される章)を機械的に除いたものを使う。
  // これにより、LLMが既存章の一部をpreserveに書き漏らしても、
  // 「target以外は保護する」という原則が崩れないようにする。
  const normalizedTarget = new Set(
    normalized.target
      .map((t) => normalizeHeading(t))
      .filter((t) => t.length > 0)
  );

  const preserveHeadings = getCurrentHeadings(
    conversation.currentOutput
  ).filter(
    (heading) => !normalizedTarget.has(normalizeHeading(heading))
  );

  saveReconstructionLog({
    previousTask,
    userInput,
    currentOutputSummary,
    messageHistory,
    status: "success",
    reconstructed: normalized,
    composedTask,
    preserveHeadings,
    isFullRewrite,
    // STEP37: デバッグ用に、安全網が実際にLLMの判定を上書きしたかを
    // 記録する。新しい永続化機構は追加せず、既存のlogs/*.jsonへ
    // 追記するだけ。
    requestTypeGuard: {
      llmRequestType: rawRequestType,
      guardedRequestType,
      overridden: rawRequestType !== guardedRequestType,
    },
    // STEP51: デバッグ用に、決定されたOutput Specを記録する。
    outputSpec,
  });

  return {
    composedTask,
    preserveHeadings,
    isFullRewrite,
    requestType: normalized.requestType,
    artifactType: normalized.artifactType,
    conversationMode: normalized.conversationMode,
    // STEP51: composedTask文字列に既にOutput Spec指示として
    // 埋め込み済み。将来的な用途(UI表示・ログ参照等)のために
    // 構造化した値としても返す(artifactType/conversationModeと
    // 同じ位置づけ)。
    outputSpec,
  };

}
