// Reviewerが返すapprovedを明示的に解釈する。
// truthy/falsy判定に依存すると、万一 "false" という文字列が
// 返ってきた場合に Boolean("false") === true と誤判定されるため、
// ここで想定される値だけを明示的にtrue/falseへ変換する。
// 想定外の値は安全側(承認しない=retry判定へ)に倒す。
// STEP68: Writer Revisionの判定条件(context.writerCritique.approved)
// でも同じ解釈が必要になったため、exportして再利用する。
// 関数の実装・挙動は一切変更していない。
export function resolveApproved(
  value: unknown
): boolean {

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return false;

}

export function handleReviewer(
  parsed: any,
  context: any,
  dynamicPlan: any[],
  reviewCount: number,
  maxReview: number
) {

  if (resolveApproved(parsed.approved)) {

    console.log("Reviewer Approved");

    return {
      reviewCount,
      currentStep: null,
      shouldContinue: false,
      shouldBreak: false,
    };
  }


  reviewCount++;


  console.log(
    `Reviewer Rejected (${reviewCount}/${maxReview})`
  );


  // -----------------------------
  // Memory保存
  // -----------------------------
  const improvements: string[] =
    parsed.improvements ?? [];


  const retryAgents: string[] =
    parsed.retry ?? [];


for (const retryAgent of retryAgents) {

  context.memory[retryAgent] ??= [];

  for (const improvement of improvements) {

    if (
      !context.memory[retryAgent].includes(improvement)
    ) {
      context.memory[retryAgent].push(improvement);
    }

  }

}


  // -----------------------------
  // 最大レビュー回数到達
  // Writerへ進む
  // -----------------------------
  if (reviewCount >= maxReview) {

    console.log(
      "Max review reached. Continue to Writer."
    );


    const writerIndex =
      dynamicPlan.findIndex(
        step =>
          step.agent === "writer"
      );


    if (writerIndex !== -1) {

      console.log(
        "Continue -> Writer"
      );


      return {

        reviewCount,

        currentStep:
          writerIndex,

        shouldContinue:
          true,

        shouldBreak:
          false,

      };

    }


    return {

      reviewCount,

      currentStep: null,

      shouldContinue:
        false,

      shouldBreak:
        true,

    };

  }



  console.log(
    "Retry Agents:",
    retryAgents
  );



  // -----------------------------
  // Retry Agentへ戻る
  // -----------------------------
  if (retryAgents.length > 0) {


    const retryIndex =
      dynamicPlan.findIndex(

        step =>
          retryAgents.includes(
            step.agent
          )

      );


    if (retryIndex !== -1) {


      console.log(
        `Restart from ${dynamicPlan[retryIndex].agent}`
      );


      return {

        reviewCount,

        currentStep:
          retryIndex,

        shouldContinue:
          true,

        shouldBreak:
          false,

      };

    }

  }



  // -----------------------------
  // fallback
  // Researcherへ戻す
  // -----------------------------
  const researcherIndex =
    dynamicPlan.findIndex(

      step =>
        step.agent === "researcher"

    );



  if (researcherIndex !== -1) {


    console.log(
      "Fallback -> Researcher"
    );


    return {

      reviewCount,

      currentStep:
        researcherIndex,

      shouldContinue:
        true,

      shouldBreak:
        false,

    };

  }



  return {

    reviewCount,

    currentStep:
      null,

    shouldContinue:
      false,

    shouldBreak:
      false,

  };

}