import {
  classifyIntent,
  looksLikeAdditionalResearchRequest,
  looksLikeResearchContinuation,
} from "../tact-intent/ruleRouter";
import { extractResearchTopic } from "../tact-research/queryGeneration";
import type { OrchestrationRequest } from "./types";
import type { Task } from "./task";
// CAP-P1c: Task meaning -> Canonical Capability -> execution binding、
// という意味論的に決定される単一のCapabilityPlanを、
// assignedCapability(execution binding)より前に(あるいは同時に)
// 参照する。
import { planCapabilityForIntent, type CapabilityPlan } from "./capabilityPlan";

// =========================
// decomposeTask (Phase 3、Phase 10で比較表現の自然言語耐性を追加)
// =========================
//
// Commander本体(commander.ts)から分離した、独立した責務(STEP絶対条件:
// 「分解ロジックは将来LLM-based Dynamic Decompositionへ差し替えられる
// よう、Commander本体と分離する」)。Phase 3では自律的なLLMベースの
// Task分解を行わず、ルールベースの最小Decomposerとする。Phase 10でも
// この方針は維持し、LLM/Embeddingは追加しない。
//
// 判定の優先順位:
//   1. 比較パターン(独立した複数調査 → 並列実行可能): "AについてX、
//      Bと比較して" のような、2つの独立した対象を持つ入力を2つの
//      researchタスクへ分解する。両者に依存関係は無い(Aggregatorが
//      比較そのものを行う、Task自体を「比較する」責務にはしない)。
//   2. 並列表現による比較パターン(Phase 10): "AとBをそれぞれ調べて
//      比較して"のような、比較対象2つを"AとB"という並列表現でまとめて
//      提示し、個別調査を明示的に要求する表現。上記1のパターンは
//      「Aについて調べ...Bと比較」という対象が2箇所に分かれた構造
//      前提のため、この構造(対象が1箇所にまとまる)には対応できず、
//      Phase 8 Reality Testで実際に取りこぼしが確認された
//      (詳細はLISTED_SUBJECTS_COMPARE_PATTERNのコメント参照)。
//   3. 依存パターン(順序性のある2段階の依頼): "AについてX、その結果
//      をもとにY" のような、後続処理が前段の結果を要求する入力を、
//      dependenciesで結んだ2 Taskへ分解する。
//   4. それ以外はSimple Task(1件)。capability判定はcore/tact-intent/
//      ruleRouter.tsのclassifyIntent()をそのまま再利用する
//      (STEP216で確立済みの「調べるってどういう意味?」等の誤判定
//      対策を含むロジックを重複実装しない)。
//
// 重要な制約(絶対条件8): Sub-agentからSub-agentを生成するnested
// spawnは行わない。decomposeTask()が返すTask[]は常にフラットな
// 1階層の配列であり、実行後に新しいTaskを動的追加する経路は
// executor.ts/commander.tsのどこにも存在しない。

// 独立した2対象の比較: 「A社について調査し、競合3社と比較して」等。
const COMPARE_PATTERN =
  /^(.+?)(?:について|を)(?:調べ|調査)(?:て|し)(?:て)?、?\s*(.+?)と比較/;

// Phase 10: 「AとBをそれぞれ調べて比較して」のような、比較対象2つを
// 「AとB」という並列表現でまとめて提示し、個別調査を明示的に要求する
// 表現を扱う。上のCOMPARE_PATTERNは「Aについて調べ...Bと比較」という
// 2箇所に対象が現れる構造を前提としており、「AとB」を1箇所にまとめて
// 述べる構造(Phase 8 Reality Testで実際に取りこぼしを確認した表現)
// には対応できない。
//
// 絶対条件(Phase 10 Step4): 「それぞれ」等の語が存在するだけで
// 無条件に分解しない。「AとB」という複数対象の並列提示と、
// 「それぞれ/各々/個別に/別々に」という個別調査の明示的要求の
// 両方が揃った場合のみ分解する。個別調査の明示が無い比較依頼
// (例:「AとBを比較して」「AとBについて調査して」)は、対象語を
// 誤って引き剥がして無理に2 Taskへ分解するより、1 Taskとして扱う方が
// 安全(絶対条件18: False PositiveをRecallより優先して避ける)。
//
// 対象抽出の安全性(Step5): 「と」「の」といった助詞・接続語自体を
// 比較対象として抽出しないよう、group1/group2は「について|を|の」の
// 直前までの非貪欲マッチとする(単一文字・助詞だけを対象として誤抽出
// することを構造的に防ぐ。抽出結果が空文字になった場合は分解しない
// 安全策も既存2パターンと同様に維持する)。
const INDIVIDUAL_INVESTIGATION_MARKER = "(?:それぞれ|各々|個別に|別々に)";

const LISTED_SUBJECTS_COMPARE_PATTERN = new RegExp(
  "^(.+?)と(.+?)(?:について|を|の).*?" +
  INDIVIDUAL_INVESTIGATION_MARKER +
  ".*?(?:調べ|調査).*?比較"
);

// 逐次依存: 「Aについて調べて、その結果をもとに要約してください」等。
// 長い接続表現を先に置き、短い「その結果」だけの表現より優先して
// 消費させる(JS正規表現の交代は左から順に試行されるため)。
const SEQUENTIAL_PATTERN =
  /^(.+?)(?:について|を)(?:調べ|調査)(?:て|し)(?:て)?、?(?:その結果をもとに|その結果を踏まえて|それをもとに|それを踏まえて|を踏まえて|その結果)、?(.+?)(?:して)?(?:ください)?。?$/;

// CAP-P1c: assignedCapability(HOW、execution binding)と
// canonicalCapability(WHAT、Canonical Capability要件)は、常に同じ1つの
// CapabilityPlan(渡さない場合はnull/undefined = Capability要件なし)
// から同時に導出する——一方だけを個別に渡す呼び出しを許さない
// (絶対条件Section6: 「dispatch keyを先に決め、意味論的Capabilityを
// 事後的に逆算する」という順序に戻らないための構造的な保証)。
function makeTask(
  description: string,
  plan?: CapabilityPlan | null,
  dependencies?: string[]
): Task {

  return {

    id: crypto.randomUUID(),

    description,

    status: "pending",

    assignedCapability: plan?.binding,

    canonicalCapability: plan?.capability,

    dependencies,

  };

}

export function decomposeTask(
  request: OrchestrationRequest
): Task[] {

  const contextPlan = request.contextResolutionPlan;
  if (contextPlan?.kind === "ready") {

    // TACT-REF-LIVE-1(REF-P1 LIVE Diagnostic 1、temporary): このTurnの
    // Context Resolution Planが実際にどのsourceを含んでいたかの最小限の
    // 診断ログ(query文字列自体・request textは出さない)。安全に削除
    // 可能、または運用診断として残してよい。
    console.log("[tact-ref-live] decompose_context_ready", JSON.stringify({
      hasNotion: !!contextPlan.sources.notion,
      hasGmail: !!contextPlan.sources.gmail,
    }));

    const tasks: Task[] = [];

    if (contextPlan.sources.notion) {
      const query = contextPlan.sources.notion.query;
      // CAP-P1c: classifyIntent()を経由しない経路(Slack context由来の
      // Context Resolution Plan)でも、同じ意味論的Capability
      // (organizational_context.read)の宣言を共有する——生のdispatch
      // key文字列をここで再度書き下ろさない。
      tasks.push(makeTask(`Notionで「${query}」を検索して`, planCapabilityForIntent("integration_notion_search")));
      // The adapter resolves title references only when unique before the
      // bounded page read; ambiguous search results are never selected here.
      tasks.push(makeTask(`Notionの「${query}」を読んで`, planCapabilityForIntent("integration_notion_read_page")));
    }

    if (contextPlan.sources.gmail) {
      tasks.push(makeTask(
        `Gmailから「${contextPlan.sources.gmail.query}」を検索して`,
        planCapabilityForIntent("integration_gmail_search_messages")
      ));
    }

    return tasks;
  }

  const input = request.input.trim();

  const compareMatch = input.match(COMPARE_PATTERN);

  if (compareMatch) {

    const subjectA = compareMatch[1].trim();
    const subjectB = compareMatch[2].trim();

    if (subjectA && subjectB) {

      const researchPlan = planCapabilityForIntent("research");

      return [
        makeTask(`${subjectA}について調査する`, researchPlan),
        makeTask(`${subjectB}について調査する`, researchPlan),
      ];

    }

  }

  const listedSubjectsCompareMatch = input.match(
    LISTED_SUBJECTS_COMPARE_PATTERN
  );

  if (listedSubjectsCompareMatch) {

    const subjectA = listedSubjectsCompareMatch[1].trim();
    const subjectB = listedSubjectsCompareMatch[2].trim();

    // 対象抽出の安全性(Step5): 助詞・単一文字・空文字を対象として
    // 扱わない。既存2パターンと同じ最小限のガード。
    if (subjectA && subjectB) {

      const researchPlan = planCapabilityForIntent("research");

      return [
        makeTask(`${subjectA}について調査する`, researchPlan),
        makeTask(`${subjectB}について調査する`, researchPlan),
      ];

    }

  }

  const sequentialMatch = input.match(SEQUENTIAL_PATTERN);

  if (sequentialMatch) {

    const subject = sequentialMatch[1].trim();
    const followUpAction = sequentialMatch[2].trim();

    if (subject && followUpAction) {

      const researchTask = makeTask(`${subject}について調査する`, planCapabilityForIntent("research"));

      // followUpTaskは前段Research Taskの結果を要約/後処理するだけの
      // Taskであり、それ自体はCapability Registry dispatchを必要と
      // しない(既存のchat fallback、Phase 3以来変更していない)。
      const followUpTask = makeTask(
        `調査結果をもとに${followUpAction}する`,
        null,
        [researchTask.id]
      );

      return [researchTask, followUpTask];

    }

  }

  // Simple Task: 1件。capability判定はIntent Router(STEP216)の
  // classifyIntent()を再利用する。core_pushはPhase 3のOrchestrator
  // ではCapability Registry未登録(core/tact-bootstrap.tsが登録
  // 済みなのはresearch/designのみ)のため、chatと同じ既定経路
  // (assignedCapability未指定 → executor.tsがChat Handlerへ
  // フォールバック)として扱う。TACT CoreへのPush判断をOrchestrator
  // が自律的に行うことはPhase 3のスコープ外。
  // Phase86: request.previousUserInput(直前Turnのuser発言、呼び出し元が
  // 既存のConversation履歴から渡す)をclassifyIntent()へそのまま透過
  // する。「具体例を5件追加で確認してください」のような、直前Turnが
  // Researchだった場合にのみResearchとして扱うべき追加調査要求を
  // 判定するために使う(Section3)。
  const decision = classifyIntent(input, request.previousUserInput);

  // CAP-P1c(旧: Architecture Migration Phase C2.1b/C2.2): 以前は
  // decision.intentから直接Capability Registry dispatch key
  // (例:"integration.slack.send_message")を三項演算子で作り、
  // Canonical Capabilityはそこから事後的に逆算していた。現在は
  // planCapabilityForIntent()(core/tact-orchestrator/capabilityPlan.ts)
  // が、Canonical Capability(WHAT)とexecution binding(HOW)を
  // 同じ1つのCapabilityPlanとして同時に返す——「dispatch keyを先に
  // 決めて意味論的Capabilityを後から逆算する」順序には戻らない。
  // decision.intentがCapability Registry dispatchを必要としない
  // (chat/core_push)場合はnullを返す(fail closedの推測ではなく、
  // 「そもそもCapability要件が無い」という正当な結果)。
  const plan = planCapabilityForIntent(decision.intent);

  // =========================
  // Phase88: 直前Turnの主題をTask.descriptionへ補完する
  // =========================
  //
  // Root Cause(Phase87投資調査): 「さっき調べた内容に、〜をさらに
  // 5件ほど追加で確認してください」のような追加調査要求は、
  // Phase86によりResearch Capabilityへ正しくルーティングされるように
  // なった(assignedCapability="research")。しかしTask.description
  // (=このままResearchParams.queryとしてSearchへ渡る文字列、
  // composeInputWithDependencies()→executor.ts参照)には、直前Turンで
  // 確立された核心トピック(「愛知県」「スポーツイベント」等)が
  // 一切含まれない——「さっき調べた内容」という指示語で前Turnを参照
  // しているだけであり、検索クエリとしては実質的にトピックを失って
  // いる(実Reality Testで検索結果0件を確認)。
  //
  // 修正: looksLikeAdditionalResearchRequest()/looksLikeResearchContinuation()
  // (Phase86で確立済み、classifyIntent()自身がResearchかどうかを判定
  // するために使っている決定論的パターン)を再利用し、「このTurnが
  // 前Turnを引き継ぐ追加調査要求だ」と判定できた場合にのみ、
  // extractResearchTopic()(Phase88新設、tact-research層で独立実装、
  // 前Turn全文ではなくトピック部分だけを抽出)で得た前Turnの主題を
  // Task.descriptionへ補完する。
  //
  // 絶対条件: 「AとBが無関係な話題」の場合は補完しない。「東京のIT
  // 企業のインターンについて調べてください」のような、それ自体で
  // 完結した新しい調査要求はRESEARCH_PATTERN(基本パターン)に直接
  // 一致し、looksLikeAdditionalResearchRequest/looksLikeResearchContinuation
  // (「追加/さらに/他にも/別の/もう少し」等の継続マーカーを必須と
  // する)には一致しないため、この分岐に入らず補完されない
  // (Phase88 Multi-turn unrelated topicテストで確認)。
  let taskDescription = input;

  const isResearchPlan = plan?.capability === "research.perform";

  if (
    isResearchPlan &&
    request.previousUserInput &&
    (looksLikeAdditionalResearchRequest(input) ||
      looksLikeResearchContinuation(input, request.previousUserInput))
  ) {

    const previousTopic = extractResearchTopic(request.previousUserInput);

    if (previousTopic && !input.includes(previousTopic)) {
      taskDescription = `${previousTopic} ${input}`;
    }

  }

  const task = makeTask(taskDescription, plan);

  // Phase90: Table Schema(列構成・要求件数)をResearch Taskへ引き継ぐ。
  // Research Capability以外のTaskには意味を持たないため設定しない。
  if (isResearchPlan && request.tableSchema) {
    task.tableSchema = request.tableSchema;
  }

  return [task];

}
