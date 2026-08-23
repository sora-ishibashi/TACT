import { Workflow } from "./types";
import * as AgentsModule from "../agents";
import { createContext } from "../context";
import { runAgent, reviewWriterOutput, reviseWriterOutput } from "./runAgent";
import { handlePlanner } from "./handlePlanner";
import { handleReviewer, resolveApproved } from "./handleReviewer";
import { QUALITY_PROFILE_CONFIG } from "./qualityProfile";
import { WorkflowEvent, Evidence, ArtifactType, Destination } from "../context/types";
import { checkEvidence } from "../evidence/checkEvidence";
import { optimizeExecution} from "../optimizer/optimizer";
import { getExecutionHistory, saveExecutionRecord} from "../brain/history";
import { analyzePatterns, analyzeModelTierPatterns} from "../brain/pattern";
import { optimizeWorkflow, recommendModelTier} from "../brain/optimizer";
import { resolveEffectiveModelTier } from "../brain/effectiveModelTier";
import { analyzeExecution } from "../brain";
import {saveBrainMemory, refreshRelevantBrainMemory, saveImprovementProposals} from "../brain/memory";

const { agents } = AgentsModule;


export function createWorkflow(workflow: Workflow) {

  console.log(
    "Workflow created:",
    workflow.name
  );

  return workflow;

}



export async function runWorkflow(
  workflow: Workflow,
  userInput: string,
  mode: "quick" | "think" | "deep" = "think",
  onEvent?: (event: WorkflowEvent) => void,
  currentOutput?: unknown,
  // STEP18: Conversation層が過去のWorkflowRunから集めたEvidence。
  // 未指定時は従来どおりcontext.evidence = []から開始する
  // (単発実行・既存の呼び出し元の挙動は一切変わらない)。
  seedEvidence?: Evidence[],
  // STEP74: Conversation層(reconstructCurrentTask())が既に算出済みの
  // artifactTypeを構造的に受け取る。既存の呼び出し元(app/api/tact/route.ts・
  // app/api/tact/stream/route.ts等、Conversation層を経由しない経路)は
  // この引数を渡さないため、undefinedのまま動作する
  // (=既存挙動を一切変えない)。
  artifactType?: ArtifactType,
  // STEP74: 新設。省略時はcreateContext()側で"tact"へフォールバックする
  // (安全側デフォルト)。
  destination?: Destination,
  // STEP75: Task Reconstruction前の生に近いユーザー発言。渡された場合、
  // 下記handlePlanner()呼び出しでevidenceMode/qualityProfileの判定材料
  // として userInput(composedTask) より優先して使う。
  rawUserInput?: string,
  // STEP131: server側でSupabase Authのセッショントークンを検証して
  // 確定したuserId(core/auth/getAuthenticatedUser.ts)。未指定
  // (未認証、またはConversation層を経由しない呼び出し)の場合は
  // undefinedのまま(既存呼び出し元の挙動は変えない)。
  userId?: string | null,
  // 最速実装モード STEP2: Brain Memory/Execution Historyを
  // Conversationへ紐付けて永続化するための任意ID。未指定の場合は
  // nullのまま保存する(既存呼び出し元の挙動は変えない)。
  conversationId?: string | null,
  // STEP159: Conversation層(runConversationTurn())がTask
  // Reconstructionで既に消費したLLMコスト。未指定(Conversation層を
  // 経由しない呼び出し、またはTask Reconstruction失敗時)の場合は
  // createContext()側が{tokens:0, estimatedUSD:0}から開始する
  // (既存呼び出し元の挙動は変えない)。
  taskReconstructionCost?: { tokens: number; estimatedUSD: number }
) {


  const context =
    createContext(
      userInput,
      mode,
      currentOutput,
      seedEvidence,
      artifactType,
      destination,
      rawUserInput,
      userId,
      taskReconstructionCost
    );

// ==========================
// Brain Optimizer
// ==========================

// STEP146-E: context.userId(server側で検証済み)でスコープする。
const history =
  await getExecutionHistory(
    context.userId
  );

// 最速実装モード STEP3: 今回のtask・userに関連する記憶だけを
// DBから取得する。DB未接続・migration未適用でも例外は投げず、
// 空配列にフォールバックする(refreshRelevantBrainMemory内部で保証)。
//
// STEP147: 戻り値をcontext.brainMemory(このWorkflow実行専用の
// スナップショット)へ保持する。以前はここでmodule-scopeの共有配列を
// 書き換えていたため、複数Workflowの同時実行時にMemoryが混ざる
// Race Conditionが理論上存在した(STEP146で発見)。context(1回の
// runWorkflow()呼び出しにつき1つ新規生成され、他のWorkflowと
// 共有されない)へ保持することで、共有可変状態を経由せずに
// core/prompt/builder.tsまで値を伝播させる。
context.brainMemory =
  await refreshRelevantBrainMemory(
    userInput,
    userId
  );


const patterns =
  analyzePatterns(
    history
  );


// STEP160: TaskProfile(category/evidenceMode/qualityProfile/
// modelTier)とExecutionRecord.costを軸としたPattern分析。この時点
// ではまだcontext.taskProfileが未確定(Planner未実行)のため、
// Recommendationの算出自体はPlanner実行後(下のdynamicPlanループ内、
// context.taskProfile確定直後)まで行わない。ここではhistory
// (既に取得済み)からPatternの集計だけを済ませておく。
const modelTierPatterns =
  analyzeModelTierPatterns(
    history
  );


const brainRecommendation =
  optimizeWorkflow(
    userInput,
    patterns
  );


if(
  brainRecommendation
){

  console.log(
    "Brain Recommendation"
  );

  console.log(
    brainRecommendation
  );

}

  const executionStartTime =
    Date.now();



  console.log(
    "Running workflow:",
    workflow.name,
    `(${mode})`
  );



  let dynamicPlan = [
    ...workflow.steps,
  ];


  let plannerExecuted = false;


  let currentStep = 0;


  let reviewCount = 0;


  const MAX_REVIEW = 3;



  while (
    currentStep < dynamicPlan.length
  ) {


    const step =
      dynamicPlan[currentStep];



    const agent =
      agents.find(
        a => a.id === step.agent
      );



    if (!agent) {

      throw new Error(
        `Agent '${step.agent}' not found.`
      );

    }



    console.log(
      `${agent.name} -> ${step.task}`
    );



    // ==========================
    // Agent開始
    // ==========================


    context.agentStatus[agent.id] =
      "running";



    const startEvent: WorkflowEvent = {

      type: "start",

      agent: agent.id,

      timestamp: Date.now(),

    };



    context.events.push(
      startEvent
    );


    onEvent?.(
      startEvent
    );



    context.logs.push({

      agent: agent.id,

      message: "Started",

      timestamp: Date.now(),

    });



    let parsed;



    try {


      parsed =
        await runAgent(
          agent,
          step,
          context
        );



      context.agentStatus[agent.id] =
        "completed";



      const completeEvent: WorkflowEvent = {

        type: "complete",

        agent: agent.id,

        timestamp: Date.now(),

      };



      context.events.push(
        completeEvent
      );


      onEvent?.(
        completeEvent
      );



      context.logs.push({

        agent: agent.id,

        message: "Completed",

        timestamp: Date.now(),

      });



    } catch(error) {


      context.agentStatus[agent.id] =
        "failed";



      const failedEvent: WorkflowEvent = {

        type: "failed",

        agent: agent.id,

        timestamp: Date.now(),

      };



      context.events.push(
        failedEvent
      );


      onEvent?.(
        failedEvent
      );



      context.logs.push({

        agent: agent.id,

        message: "Failed",

        timestamp: Date.now(),

      });



      throw error;


    }




    // ==========================
    // Planner
    // ==========================


    const plannerResult =
      handlePlanner(
        agent.id,
        parsed,
        plannerExecuted,
        currentStep,
        // STEP75: rawUserInput(Task Reconstruction前の生に近い発言)が
        // 渡されていればそちらを優先する。EvidenceMode/QualityProfileの
        // 判定材料がcomposedTask(LLMによる言い換え)経由でキーワードを
        // 失う問題(STEP74で観測)への対応。rawUserInputが無い場合
        // (Conversation層を経由しない呼び出し)は、既存通り
        // context.userInputをそのまま使う。
        context.rawUserInput ?? context.userInput
      );



    if (
      plannerResult.shouldContinue
    ) {


      plannerExecuted =
        plannerResult.plannerExecuted;



      dynamicPlan =
        plannerResult.dynamicPlan!;



      currentStep =
        plannerResult.currentStep;



      // STEP70: handlePlanner()が算出したEvidenceModeを、
      // 実行履歴・コスト比較のためcontextへ保持する。
      // 存在しない場合(型は any 経由のため未定義になり得る)は
      // context.evidenceModeを変更しない。
      if (plannerResult.evidenceMode) {

        context.evidenceMode =
          plannerResult.evidenceMode;

      }


      // STEP71: handlePlanner()が算出したQualityProfileを、
      // Writer Critique/Revisionの実行有無の判断に使うため
      // contextへ保持する。
      if (plannerResult.qualityProfile) {

        context.qualityProfile =
          plannerResult.qualityProfile;

      }


      // STEP156: handlePlanner()が算出したTaskProfileをcontextへ
      // 保持する。現時点ではLLM選択・Search実行の分岐には使わず、
      // 実行履歴(ExecutionRecord)への記録のみを目的とする。
      if (plannerResult.taskProfile) {

        context.taskProfile =
          plannerResult.taskProfile;

        // STEP160: TaskProfileが確定した直後に、過去実績から
        // modelTierのRecommendationを算出する。ここではログ・
        // ExecutionRecordへの記録のみを行い、
        // context.taskProfile.modelTier自体は書き換えない
        // (絶対条件: BrainRecommendation→TaskProfile.modelTier変更の
        // 実接続はSTEP160では行わない)。過去データが不十分な場合は
        // recommendModelTier()自体がnullを返す(無理な推奨をしない)。
        const modelTierRecommendation =
          recommendModelTier(
            context.taskProfile,
            modelTierPatterns
          );

        if (modelTierRecommendation) {

          context.modelTierRecommendation =
            modelTierRecommendation;

        }

        // STEP161: Base Model Tier(context.taskProfile.modelTier)・
        // Brain Recommendation・安全制約を踏まえたEffective Model
        // Tierを決定する。context.taskProfile.modelTier自体は
        // 一切書き換えない(絶対条件11)。recommendModelTier()が
        // nullを返した場合(データ不足等)、resolveEffectiveModelTier()
        // 内部でBase Model Tierへフォールバックする。
        //
        // STEP163: この値はcore/workflow/runAgent.tsの各
        // resolveExecutionStrategy()呼び出しで実際に使用される
        // (context.effectiveModelTier ?? context.taskProfile?.modelTier)。
        // Brainの生Recommendationを直接渡すことはなく、必ず
        // resolveEffectiveModelTier()の安全制約を経由した値のみが
        // 実行へ反映される。
        context.effectiveModelTier =
          resolveEffectiveModelTier(
            context.taskProfile,
            context.modelTierRecommendation
          );

      }



      continue;

    }





    // ==========================
    // Evidence Check
    // ==========================


    const evidenceIssues =
      checkEvidence(
        context.evidence
      );



    if (
      evidenceIssues.length > 0
    ) {

      console.log(
        "Evidence Issues"
      );


      console.table(
        evidenceIssues
      );

    }





    // ==========================
    // Reviewer
    // ==========================


    if (
      agent.id === "reviewer"
    ) {


      const reviewerResult =
        handleReviewer(
          parsed,
          context,
          dynamicPlan,
          reviewCount,
          MAX_REVIEW
        );



      reviewCount =
        reviewerResult.reviewCount;



      if (
        reviewerResult.shouldBreak
      ) {

        break;

      }



      if (
        reviewerResult.shouldContinue
      ) {


        currentStep =
          reviewerResult.currentStep!;


        continue;


      }


    }



    currentStep++;


  }


  // ==========================
  // Writer Critique (STEP67)
  // ==========================
  //
  // 既存のReviewer(retry/loopを伴う通常のWorkflow Reviewer)とは
  // 完全に分離した、Writer実行後の1回限りの追加レビュー。
  // dynamicPlanへは一切追加しない(Plannerのチーム編成ロジックは
  // 変更しない)ため、handleReviewer()のretry/loop処理・
  // context.outputs.reviewer・context.reviewHistoryには触れない。
  // Writerは再実行しない。失敗してもWorkflow全体は止めない。
  //
  // STEP71: context.qualityProfileが未設定の場合(Plannerがcategoryを
  // 返さなかった等の既存フォールバック経路。context.evidenceModeも
  // 同様に未設定になる)は、STEP67/68時点の既存挙動(常にCritiqueを
  // 実行する)をそのまま維持する安全側のデフォルトを使う。
  const qualityProfileConfig =
    context.qualityProfile
      ? QUALITY_PROFILE_CONFIG[context.qualityProfile]
      : { allowsCritique: true, allowsRevision: true };

  if (
    context.outputs.writer &&
    qualityProfileConfig.allowsCritique
  ) {

    try {

      const reviewerAgent =
        agents.find(a => a.id === "reviewer");

      if (reviewerAgent) {

        const critique =
          await reviewWriterOutput(
            reviewerAgent,
            context
          );

        if (critique) {

          context.writerCritique = critique;

          context.logs.push({
            agent: "reviewer",
            message: "Writer critique completed (STEP67)",
            timestamp: Date.now(),
          });

          console.log("Writer Critique Result (STEP67)");
          console.log(critique);

        }

      }

    } catch (error) {

      console.warn(
        "[WriterCritique] failed, continuing without blocking workflow.",
        error
      );

    }

  }


  // ==========================
  // Writer Revision (STEP68)
  // ==========================
  //
  // 「Writer -> Reviewer -> Revision -> Reviewer再確認」を最大1回だけ
  // 実行する。この節はループの外側にある直線的なコードであり、
  // ループ構造を一切持たないため、Revision・再確認ともに
  // 実行されるとしても必ず1回だけになる(コード上、複数回実行される
  // 経路が存在しない)。
  //
  // 既存のhandleReviewer()のretry/loop処理(Researcher等への差し戻し)
  // ・context.outputs.reviewer(Writer実行前のReviewer判定。
  // core/brain/analyzer.ts・core/advisor/buildAdvisorContext.tsが
  // 参照する既存の意味)には一切触れない。
  //
  // Revision後のWriter出力は、既存のFinal Output算出
  // (下のcontext.outputs.writerを参照する行)・
  // core/conversation/index.tsのreconcileCurrentOutput()/run.outputsが
  // 追加の分岐なしにそのまま扱えるよう、context.outputs.writer自体を
  // 上書きする(=Writerが再実行されるたびにcontext.outputs.writerが
  // 更新される、という既存の意味と一致させるため)。

  if (
    context.outputs.writer &&
    context.writerCritique &&
    qualityProfileConfig.allowsRevision &&
    resolveApproved(
      (context.writerCritique as { approved?: unknown }).approved
    ) === false
  ) {

    try {

      const writerAgent =
        agents.find(a => a.id === "writer");

      if (writerAgent) {

        const originalWriterOutput =
          context.outputs.writer;

        const revised =
          await reviseWriterOutput(
            writerAgent,
            context,
            context.writerCritique
          );

        if (revised) {

          context.writerRevision = {
            originalOutput: originalWriterOutput,
            revisedOutput: revised,
          };

          context.outputs.writer = revised;

          // core/prompt/builder.tsのbuildPrompt()が組み立てる
          // "Workflow History"はcontext.outputs(previousOutputs)ではなく
          // context.stepOutputsから作られる。ここを更新しないと、
          // 直後のReviewer再確認(STEP68)がRevision前の古いWriter出力を
          // 見てしまう。対応するstep(agent === "writer")のoutputだけを
          // 同じ内容へ更新する(新しいstepは追加しない)。
          for (const stepId of Object.keys(context.stepOutputs)) {

            if (context.stepOutputs[stepId].agent === "writer") {

              context.stepOutputs[stepId] = {
                agent: "writer",
                output: revised,
              };

            }

          }

          context.logs.push({
            agent: "writer",
            message: "Writer revision completed (STEP68)",
            timestamp: Date.now(),
          });

          console.log("Writer Revision Result (STEP68)");
          console.log(revised);

          // ==========================
          // Reviewer再確認(STEP68)
          // ==========================
          //
          // STEP67のreviewWriterOutput()をもう一度だけ実行する。
          // 結果の採否には使わない(approvedがfalseでも、この
          // Revision後Writer出力をそのままFinal Outputとして採用し、
          // ここで処理を終了する。再帰的なRevisionは行わない)。
          // 記録・診断のためだけにcontext.writerFinalCritiqueへ保存する。

          const reviewerAgent =
            agents.find(a => a.id === "reviewer");

          if (reviewerAgent) {

            const finalCritique =
              await reviewWriterOutput(
                reviewerAgent,
                context
              );

            if (finalCritique) {

              context.writerFinalCritique =
                finalCritique;

              context.logs.push({
                agent: "reviewer",
                message:
                  "Writer final critique completed (STEP68)",
                timestamp: Date.now(),
              });

              console.log(
                "Writer Final Critique Result (STEP68)"
              );

              console.log(finalCritique);

            }

          }

        }

      }

    } catch (error) {

      console.warn(
        "[WriterRevision] failed, continuing with pre-revision writer output.",
        error
      );

    }

  }


  // ==========================
  // Final Output
  // ==========================


  context.finalOutput =
    context.outputs.writer ??
    context.outputs[
      dynamicPlan[
        dynamicPlan.length - 1
      ].agent
    ] ??
    null;






// ==========================
// Self Improvement Record
// ==========================

const reviewer =
  context.outputs.reviewer as any;

context.executionRecord = {

  id:
    crypto.randomUUID(),

  userInput,

  mode,

  agents:
    Object.keys(
      context.outputs
    ),

  outputs:
    context.outputs,

  quality:
    reviewer
      ? {
          score:
            reviewer.score ?? 0,

          issues:
            reviewer.issues ?? [],

          improvements:
            reviewer.improvements ?? [],
        }
      : undefined,

  duration:
    Date.now() -
    executionStartTime,

  success:
    true,

  failedAgents:
    Object.entries(
      context.agentStatus
    )
      .filter(
        ([, status]) =>
          status === "failed"
      )
      .map(
        ([agent]) =>
          agent
      ),

  reviewerAgent:
    reviewer
      ? "reviewer"
      : undefined,

  // STEP70: 実行履歴・コスト比較のために記録するだけで、
  // Workflowの分岐には使わない(新しい課金計算システムは作らない)。
  evidenceMode:
    context.evidenceMode,

  // STEP71: 同上の位置づけ。Workflow分岐自体はcontext.qualityProfile
  // (上のqualityProfileConfig算出)で既に行われている。
  qualityProfile:
    context.qualityProfile,

  // STEP156: 同上の位置づけ(記録専用)。将来Optimizer/Brainが
  // category・modelTier・searchIntensity単位の実行パターンを
  // 分析できるようにするために保持する。Workflow分岐にはまだ
  // 使わない。
  taskProfile:
    context.taskProfile,

  // STEP160: 過去実績から算出したmodelTierの推奨(生の値)。
  // この値自体が直接実行へ渡ることはなく、必ずresolveEffectiveModelTier()
  // (STEP161)の安全制約を経由したeffectiveModelTierが実行へ使われる
  // (STEP163絶対条件2)。過去データ不足等でRecommendationが
  // 得られなかった場合はundefinedのまま。
  modelTierRecommendation:
    context.modelTierRecommendation,

  // STEP161: Base(taskProfile.modelTier)・Recommendation
  // (modelTierRecommendation.modelTier)・Effectiveの3値を区別して
  // 記録する(絶対条件11)。STEP163でこの値が実際にrunAgent.tsの
  // resolveExecutionStrategy()へ渡るようになったため、通常は
  // 「今回のRunで実際に使用されたmodelTier」と一致する。
  effectiveModelTier:
    context.effectiveModelTier,

  // STEP159: Workflow実行中に発生した全LLM呼び出し(Task
  // Reconstruction・Planner・Researcher・Analyst・Reviewer・Writer・
  // Revision・HoldConclusion等)のusage/costを積算した合計値。
  // usage/pricingが取得できなかった呼び出しは単に加算されていない
  // ため、一部の呼び出しのコストが不明でもWorkflow全体は必ず完走する
  // (絶対条件)。
  cost:
    context.costAccumulator,

  // STEP168: core/llm/runLLMWithFallback.tsが実際に呼び出した
  // Provider/Model。context.actualExecution(参照渡しで各LLM呼び出し
  // 直後に上書きされる)の、このWorkflow実行終了時点での値を
  // そのまま複製する。Fallbackが一度も発生しなければ常にopenai。
  actualProvider:
    context.actualExecution?.provider,

  actualModel:
    context.actualExecution?.model,

  critiqueExecuted:
    Boolean(context.writerCritique),

  revisionExecuted:
    Boolean(context.writerRevision),

  // STEP74: 同上の位置づけ。Workflow分岐にはまだ使わない
  // (STEP74は「分類の接続」まで。分類結果をAgent選択やCritique/Revisionへ
  // 使うのはSTEP75以降)。
  artifactType:
    context.artifactType,

  destination:
    context.destination,

  createdAt:
    Date.now(),

};

// ==========================
// Execution History保存 (最速実装モード STEP2)
// ==========================
//
// 発見された事実: context.executionRecordはこれまで構築される
// だけで、saveExecutionRecord()が一度も呼ばれていなかった
// (=core/brain/pattern.ts/optimizer.tsのパターン分析が常に
// 空データで動作していた)。ここで実際に保存する。
await saveExecutionRecord(
  context.executionRecord,
  context.userId,
  conversationId
);

// ==========================
// Brain Analysis
// ==========================
//
// 最速実装モード STEP5: patternsを渡すことで、Execution History
// パターン(同一Agent構成の過去成績)に基づく検知も行われる
// (analyzeExecution内部、patterns未指定時は従来通りスキップされる
// ため、他の呼び出し元・既存挙動には影響しない)。

const brainResult =
  analyzeExecution(context, patterns);

// 最速実装モード STEP5/6: 構造化されたImprovementProposalを
// tact_memoryへ保存する(type: "improvement_proposal")。DB未接続でも
// 例外は投げない(saveImprovementProposals内部で保証)。
if (brainResult.proposals.length > 0) {

  await saveImprovementProposals(
    brainResult.proposals,
    context.userId,
    conversationId
  );

}

// ==========================
// Optimizer
// ==========================

const optimizerResult =
  optimizeExecution({
    ...context,
    executionRecord: {
      ...context.executionRecord!,
      quality: {
        score: brainResult.score,
        issues: brainResult.issues,
        improvements: brainResult.improvements,
      },
    },
  });

console.log("Optimizer Result");
console.log(optimizerResult);

// ==========================
// Brain Memory保存
// ==========================

if (
  optimizerResult.appliedRules.length > 0
) {

  await saveBrainMemory(
    optimizerResult.appliedRules,
    context.userId,
    conversationId
  );

}


return context;
}