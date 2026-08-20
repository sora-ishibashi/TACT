import {
  WorkflowContext
} from "../context/types";

import {
  BrainAnalysis,
  BrainRule,
  ImprovementProposal
} from "./types";

import { BrainPattern } from "./pattern";


export function analyzeExecution(
  context: WorkflowContext,
  // 最速実装モード STEP5: Execution Historyから算出済みのPattern
  // (core/brain/pattern.ts、runWorkflow()冒頭で既に計算されている)。
  // 省略時(既存の呼び出し元)は従来通りこのチェックだけスキップする
  // (=既存の呼び出し元・既存の挙動を一切変えない)。
  patterns?: BrainPattern[]
): BrainAnalysis {


  const issues: string[] = [];

  const improvements: BrainRule[] = [];

  const nextRules: BrainRule[] = [];

  const proposals: ImprovementProposal[] = [];



  // ==========================
  // Reviewer結果確認
  // ==========================
  //
  // context.outputsはRecord<string, unknown>のため、Reviewer出力の
  // 形(outputFormats.tsのreviewerエントリ)を最小限だけ型付けする。
  // Reviewer自体のOutput Schemaは変更しない(読み取り専用のcast)。

  const reviewer =
    context.outputs.reviewer as
      | {
          issues?: unknown;
          improvements?: unknown;
        }
      | undefined;


  if (
    reviewer
  ) {


    if (
      reviewer.issues &&
      Array.isArray(reviewer.issues)
    ) {

      issues.push(
        ...reviewer.issues
      );

    }



    if (
      reviewer.improvements &&
      Array.isArray(reviewer.improvements)
    ) {


      for (
        const item of reviewer.improvements
      ) {


        const ruleText =
          typeof item === "string"
            ? item
            : item.rule ?? "Unknown";


        improvements.push({

          rule:
            ruleText,


          reason:
            "Reviewer改善要求を反映",


          createdAt:
            Date.now(),

        });


        proposals.push({

          problem:
            `Reviewerが品質課題を指摘した: ${ruleText}`,

          causeHypothesis:
            "Writer(または上流Agent)の出力が、Reviewerの品質基準を" +
            "満たしていなかった可能性がある。具体的な原因は" +
            "Reviewer.issuesの文面のみからは特定できない。",

          evidence:
            `今回のReviewer.issues: ${JSON.stringify(reviewer.issues ?? [])}`,

          affectedAgent:
            "writer",

          suggestion:
            ruleText,

          expectedEffect:
            "同種の指摘が今後のReviewerで減少する",

          confidence:
            "low",

          createdAt:
            Date.now(),

        });


      }

    }

  }



  // ==========================
  // Evidence品質確認
  // ==========================

  if (
    context.evidence.length === 0
  ) {


    issues.push(
      "Evidenceが不足"
    );


    improvements.push({

      rule:
        "Researcherの検索品質を改善",


      reason:
        "Evidence不足を防ぐため",


      createdAt:
        Date.now(),

    });


    nextRules.push({

      rule:
        "Researcherは一次情報を優先する",


      reason:
        "Evidence信頼性向上のため",


      createdAt:
        Date.now(),

    });


    proposals.push({

      problem:
        "Evidenceが0件のままWorkflowが完了した",

      causeHypothesis:
        "Researcherが検索を実行しなかった、または検索結果から" +
        "Evidenceを生成できなかった可能性がある。",

      evidence:
        "context.evidence.length === 0",

      affectedAgent:
        "researcher",

      suggestion:
        "Researcherは一次情報を優先して検索し、Evidenceを必ず" +
        "生成する",

      expectedEffect:
        "Evidence信頼性・Writer出力の裏付け向上",

      confidence:
        "medium",

      createdAt:
        Date.now(),

    });

  }



  // ==========================
  // Agent失敗確認
  // ==========================

  const failedAgents =
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
    );


  if (
    failedAgents.length > 0
  ) {


    issues.push(
      `Failed Agents: ${failedAgents.join(",")}`
    );


    const rule: BrainRule = {

      rule:
        "失敗したAgentの処理を確認する",


      reason:
        "Workflow安定性向上のため",


      createdAt:
        Date.now(),

    };


    improvements.push(rule);

    nextRules.push(rule);


    proposals.push({

      problem:
        `Agent実行が失敗した: ${failedAgents.join(", ")}`,

      causeHypothesis:
        "LLM呼び出しエラー、JSON parse失敗、Tool実行失敗のいずれか。" +
        "詳細はcontext.logsを確認する必要がある。",

      evidence:
        `context.agentStatus: ${JSON.stringify(context.agentStatus)}`,

      affectedAgent:
        failedAgents.join(","),

      affectedWorkflow:
        "runWorkflow (該当Agentのstep)",

      suggestion:
        "失敗したAgentのエラーハンドリング・リトライ条件を見直す",

      expectedEffect:
        "Workflow完走率の向上",

      confidence:
        "medium",

      createdAt:
        Date.now(),

    });

  }



  // ==========================
  // Execution Historyパターン確認 (最速実装モード STEP5)
  // ==========================
  //
  // STEP2でsaveExecutionRecord()の呼び出しが復活したことにより、
  // 初めて意味のあるデータが溜まるようになった箇所。同じAgent構成が
  // 過去に繰り返し低品質だった場合、それ自体を問題として提起する
  // (「最近このタイプのタスクで失敗が多い」という、ユーザーが
  // 例示した検知パターンに相当する)。

  if (patterns && patterns.length > 0) {

    const currentAgents =
      Object.keys(context.outputs).sort().join(",");

    const matchingPattern = patterns.find(
      (p) => [...p.agents].sort().join(",") === currentAgents
    );

    if (
      matchingPattern &&
      matchingPattern.count >= 3 &&
      matchingPattern.averageScore < 70
    ) {

      proposals.push({

        problem:
          `Agent構成[${matchingPattern.agents.join(", ")}]で品質が` +
          "継続的に低い",

        causeHypothesis:
          "このAgent構成のPrompt・選択条件・Evidence品質のいずれかに、" +
          "繰り返し発生する構造的な弱点がある可能性がある。",

        evidence:
          `過去${matchingPattern.count}回の平均スコア: ` +
          `${Math.round(matchingPattern.averageScore)}点、` +
          `成功率: ${Math.round(matchingPattern.successRate * 100)}%`,

        affectedAgent:
          matchingPattern.agents.join(","),

        affectedWorkflow:
          "handlePlanner / getTeam (Agent構成の決定箇所)",

        suggestion:
          "このAgent構成のPromptまたはgetTeam()の選択条件を見直す" +
          "(具体的な変更内容は人間による確認が必要)",

        expectedEffect:
          "このAgent構成での平均スコア向上",

        confidence:
          "medium",

        createdAt:
          Date.now(),

      });

    }

  }



  // ==========================
  // Score
  // ==========================

  const score =
    Math.max(
      0,
      100 -
      issues.length * 10
    );



  return {

    score,

    issues,

    improvements,

    nextRules,

    proposals,

  };

}
