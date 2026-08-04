import { getTeam } from "../planner/getTeam";

export function handlePlanner(
  agentId: string,
  parsed: any,
  plannerExecuted: boolean,
  currentStep: number
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
  // QueryBuilder追加
  // ==========================

  const finalTeam = [
    ...team,
  ];


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

  };

}