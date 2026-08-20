import { getTeam } from "../planner/getTeam";
import { detectEvidenceMode, EvidenceMode } from "../evidence/evidenceMode";
import { detectQualityProfile, QualityProfile } from "./qualityProfile";

// STEP70: EvidenceMode=noneのとき、team(getTeam()の戻り値)から
// 除外するAgent。Researcher/QueryBuilderは指示通り必須の除外対象。
// Analystは「Researcherが集めたEvidenceを分析する」責務そのものが
// Evidence非依存タスクでは成立しない(新しい事実の追加を禁じられて
// いるため、Evidenceが無ければ実質何も分析できない)ため、同じ判断で
// 除外する。除外してもcategoryごとの既存team定義(getTeam.ts)自体は
// 一切変更しない。
const EVIDENCE_MODE_NONE_EXCLUDED_AGENTS = [
  "researcher",
  "queryBuilder",
  "analyst",
];

export function handlePlanner(
  agentId: string,
  parsed: any,
  plannerExecuted: boolean,
  currentStep: number,
  // STEP70: EvidenceMode判定のためにcontext.userInputを受け取る。
  // 既存の呼び出し元は1箇所(core/workflow/index.ts)のみのため、
  // シグネチャ変更の影響範囲は限定的。
  userInput: string
) {

  if (
    agentId !== "planner" ||
    plannerExecuted
  ) {

    return {
      plannerExecuted,
      currentStep,
      dynamicPlan: null,
      shouldContinue: false,
    };

  }


  console.log("Planner created plan");
  console.log(parsed);


  // categoryが存在しない場合

  if (!parsed.category) {

    console.warn(
      "Planner did not create category."
    );

    return {

      plannerExecuted: true,

      currentStep,

      dynamicPlan: [],

      shouldContinue: false,

    };

  }


  // ==========================
  // Team決定
  // ==========================

  const team =
    getTeam(parsed.category);



  // ==========================
  // Plannerが作成したtask一覧
  // ==========================

  const taskMap: Record<
    string,
    string
  > = {};


  if (
    Array.isArray(parsed.plan)
  ) {

    for (const item of parsed.plan) {

      taskMap[item.agent] =
        item.task;

    }

  }



  // ==========================
  // EvidenceMode判定 (STEP70)
  // ==========================
  //
  // STEP33のdetectResearchRequirement()と同じ理由で、composedTaskの
  // 先頭段落(=今回の指示そのもの)だけを判定対象にする。章立て一覧・
  // 過去情報要約等(2段落目以降)まで含めると誤判定の原因になるため
  // (core/workflow/runAgent.tsの既存コメント参照)。
  const currentInstruction =
    (userInput ?? "").split("\n\n")[0] ?? "";

  const evidenceMode: EvidenceMode =
    detectEvidenceMode(currentInstruction);

  console.log(
    "[EvidenceMode]",
    evidenceMode
  );



  // ==========================
  // QualityProfile判定 (STEP71)
  // ==========================
  //
  // EvidenceModeと同じ入力(先頭段落)を使うが、判定ロジック自体は
  // 別軸(core/workflow/qualityProfile.ts)。「Evidence不要=品質
  // チェック不要」にはしない。

  const qualityProfile: QualityProfile =
    detectQualityProfile(
      currentInstruction,
      evidenceMode
    );

  console.log(
    "[QualityProfile]",
    qualityProfile
  );



  // ==========================
  // Team構築
  // ==========================

  const finalTeam = [
    ...team,
  ];


  // ==========================
  // Planner明示選択によるAnalyst追加 (STEP129)
  // ==========================
  //
  // STEP128で判明した「Plannerのparsed.planに含まれるagent一覧は
  // taskMap構築にしか使われず、実行Team(finalTeam)の構成には一切
  // 反映されない」という分離を、Analystに限定して最小修正する。
  // getTeam(category)による既存Team構成(category単位のデフォルト)は
  // 変更せず、Plannerが明示的に"analyst"をplanへ含めた場合のみ、
  // finalTeamへ個別に追加する。Analyst以外のAgentへは一般化しない。
  //
  // この追加は、直後のEvidenceMode==="none"除外処理より前に行う。
  // そのためEvidenceModeが"none"の場合は、既存ロジックと同じ理由
  // (Evidenceが無ければ分析できない)でこの追加分も除外される
  // (=既存のEvidenceMode除外ロジック自体は変更しない)。
  const plannerSelectedAnalyst =
    Array.isArray(parsed.plan) &&
    parsed.plan.some(
      (item: any) => item?.agent === "analyst"
    );

  if (
    plannerSelectedAnalyst &&
    !finalTeam.includes("analyst")
  ) {

    const researcherIndex =
      finalTeam.indexOf("researcher");

    if (researcherIndex !== -1) {

      // researcherの直後(=Research→Analystの順序)に挿入する。
      finalTeam.splice(
        researcherIndex + 1,
        0,
        "analyst"
      );

    } else {

      const reviewerIndex =
        finalTeam.indexOf("reviewer");

      if (reviewerIndex !== -1) {

        // researcherがteamに無い場合は、reviewerの直前に挿入する。
        finalTeam.splice(
          reviewerIndex,
          0,
          "analyst"
        );

      } else {

        // reviewerも無い場合は末尾へ追加する(フォールバック)。
        finalTeam.push("analyst");

      }

    }

    console.log(
      "[Planner→Execution] Planner selected analyst. Added to finalTeam:",
      finalTeam
    );

  }


  // STEP70: EvidenceMode === "none" の場合のみ、Evidence依存Agentを
  // teamから除外する。それ以外(helpful/required/primary-source-required)
  // は既存のteam構成をそのまま維持する(=既存Workflowへの影響なし)。
  if (evidenceMode === "none") {

    const excludedSet =
      new Set(EVIDENCE_MODE_NONE_EXCLUDED_AGENTS);

    const skippedAgents =
      finalTeam.filter(
        (agent) => excludedSet.has(agent)
      );

    for (
      let i = finalTeam.length - 1;
      i >= 0;
      i--
    ) {

      if (excludedSet.has(finalTeam[i])) {
        finalTeam.splice(i, 1);
      }

    }

    if (skippedAgents.length > 0) {

      console.log(
        "[EvidenceMode=none] Skipping agents:",
        skippedAgents
      );

    }

  }


  // ==========================
  // QueryBuilder追加
  // ==========================
  //
  // 既存ロジックは変更しない。EvidenceMode=noneでresearcherが
  // finalTeamから既に除外されている場合、この条件は成立しない
  // (queryBuilderが誤って単独で追加されることはない)。

  if (
    finalTeam.includes("researcher") &&
    !finalTeam.includes("queryBuilder")
  ) {

    const researcherIndex =
      finalTeam.indexOf("researcher");


    finalTeam.splice(
      researcherIndex,
      0,
      "queryBuilder"
    );

  }



  // ==========================
  // Dynamic Plan生成
  // ==========================

  const dynamicPlan =
    finalTeam.map(
      (
        agent,
        index
      ) => ({

        id: String(index + 1),

        agent,

        task:
          agent === "queryBuilder"
            ? "Researcherが使用する最適な検索クエリを作成する。"
            :
            taskMap[agent] ??
            `${agent}の役割を実行する`,

      })
    );


  console.log(
    "Dynamic Plan Created"
  );


  console.table(
    dynamicPlan
  );


  return {

    plannerExecuted: true,

    currentStep: 0,

    dynamicPlan,

    shouldContinue: true,

    evidenceMode,

    qualityProfile,

  };

}
