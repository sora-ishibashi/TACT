import { tools } from "../tools";
import { Evidence } from "../context/types";
import { AgentId } from "../agents/types";
import { responsibilities } from "./responsibilities";
import { formatBrainMemory } from "../brain/memory";
import { outputFormats } from "./outputFormats";


const availableAgents = [
  "planner",
  "queryBuilder",
  "researcher",
  "designer",
  "engineer",
  "stakeholder",
  "reviewer",
  "writer",
];


const availableTools = tools
  .map(
    (tool) => `
${tool.id}
${tool.description}
`
  )
  .join("\n\n");



export function buildPrompt(
  agentId: AgentId,
  userInput: string,
  task: string,
  outputs?: Record<string, unknown>,
  stepOutputs?: Record<
    string,
    {
      agent: string;
      output: unknown;
    }
  >,
  toolResults?: Record<string, unknown>,
  memory?: Record<string, string[]>,
  handoffs?: Record<string, unknown>,
  evidence: Evidence[] = [],
  mode: "quick" | "think" | "deep" = "think"
) {


const visibleOutputs: Record<AgentId, string[]> = {

  planner: [],

  queryBuilder: [
    "planner"
  ],

  researcher: [
    "planner",
    "queryBuilder"
  ],

  analyst: [
    "planner",
    "researcher"
  ],

  designer: [
    "planner",
    "analyst"
  ],

  engineer: [
    "planner",
    "designer"
  ],

  stakeholder: [
    "planner",
    "analyst"
  ],

  reviewer: [
    "planner",
    "researcher",
    "analyst",
    "designer",
    "engineer",
    "stakeholder"
  ],

  writer: [
    "planner",
    "researcher",
    "analyst",
    "designer",
    "engineer",
    "stakeholder",
    "reviewer"
  ],

};

const previousOutputs =
  outputs
    ? visibleOutputs[agentId]
        .map((id) => {

          const output = outputs[id];

          if (!output) return null;

          return `
========================
${id.toUpperCase()}
========================

${JSON.stringify(output, null, 2)}
`;

        })
        .filter(Boolean)
        .join("\n")
    : "None";

  const queryBuilderOutput =
    agentId === "researcher" &&
    outputs?.queryBuilder
      ? JSON.stringify(
          outputs.queryBuilder,
          null,
          2
        )
      : "None";



const workflowHistory =
  stepOutputs &&
  Object.keys(stepOutputs).length > 0
    ? Object.values(stepOutputs)
        .map(
          ({ agent, output }) => `
========================
${agent.toUpperCase()}
========================

${JSON.stringify(output, null, 2)}
`
        )
        .join("\n")
    : "None";


const toolOutput =
  toolResults && Object.keys(toolResults).length > 0
    ? "[Tool Results Available]"
    : "None";



  const agentMemory =
    memory && memory[agentId]?.length
      ? memory[agentId]
          .map((m) => `- ${m}`)
          .join("\n")
      : "None";



  const brainMemory =
    formatBrainMemory();



const evidenceSummary =
  evidence
    .map(
      (e) => `
ID: ${e.id}
Claim: ${e.claim}
Source: ${e.source ?? "Unknown"}
`
    )
    .join("\n");


const agentRules: Record<AgentId, string> = {

planner: `
・ユーザー要求を整理する
・ゴールを明確にする
・Workflowを設計する
・回答を書かない
`,

queryBuilder: `
・検索戦略のみ設計する
・検索は実行しない
・Researcherが調査しやすいQueryを設計する
・回答を書かない
`,

researcher: `
・Evidenceのみ収集する
・推測しない
・分析しない
・高品質Evidenceを優先する
・出典を保持する
`,

analyst: `
・Evidenceを分析する
・比較する
・原因を整理する
・洞察を作る
・新しい事実は禁止
・Evidenceに基づいて考察する
`,

designer: `
・分析結果をUI・UXへ落とし込む
・Evidenceを優先する
・設計のみ担当する
`,

engineer: `
・技術設計を行う
・実装方針を作る
・Evidenceを優先する
`,

stakeholder: `
・ユーザー価値を評価する
・事業価値を評価する
・リスクを整理する
`,

reviewer: `
・成果物をレビューする
・Evidenceとの整合性を確認する
・改善点を抽出する
・品質だけを評価する
`,

writer: `
・完成した成果物を作成する
・Analystの分析を文章化する
・Reviewerを反映する
・新しい分析は禁止
・新しい事実は禁止
`
};


const outputFormat = outputFormats[agentId];

const handoffInstructions: Record<AgentId, string> = {

  planner: `
Planner Handoff

次に動くAgentは QueryBuilder です。

Researcherが検索しやすいように、
目的・調査対象を明確にしてください。
`,

  queryBuilder: `
QueryBuilder Handoff

次に動くAgentは Researcher です。

検索Queryだけを設計してください。
検索結果や分析を書いてはいけません。
`,

  researcher: `
Researcher Handoff

次に動くAgentは Analyst です。

分析しやすいように、
Evidenceを整理してください。
`,

  analyst: `
Analyst Handoff

次に動くAgentは Designer / Engineer / Stakeholder です。

Evidenceから

・重要な洞察
・比較
・原因
・リスク
・機会

を整理してください。
`,

  designer: `
Designer Handoff

次に動くAgentは Reviewer です。

設計判断が分かる形でまとめてください。
`,

  engineer: `
Engineer Handoff

次に動くAgentは Reviewer です。

実装判断が分かる形でまとめてください。
`,

  stakeholder: `
Stakeholder Handoff

次に動くAgentは Reviewer です。

価値・リスクを整理してください。
`,

  reviewer: `
Reviewer Handoff

次に動くAgentは Writer です。

不足点を具体的に指摘してください。
`,

  writer: `
Writer Handoff

あなたが最終Agentです。

完成品を作成してください。
`
};

return `

========================
TACT Workflow
========================

Current Agent

${agentId}



========================
Execution Mode
========================

${mode}

Quick
高速・低コスト

Think
標準品質

Deep
最高品質・時間をかける



========================
Current Task
========================

${task}



========================
Original User Request
========================

${userInput}



========================
Agent Responsibilities
========================

${responsibilities[agentId]}

========================
Current Handoff
========================

${handoffInstructions[agentId]}

========================
Available Agents
========================

${availableAgents.join("\n")}



========================
Available Tools
========================

${availableTools}



========================
Brain Memory
========================

${brainMemory}


重要:

Brain Memoryは
過去のTACT実行から抽出された
改善ルールです。

必ず参考にしてください。

ただし現在の依頼と矛盾する場合は
現在の依頼を優先してください。



========================
Reviewer Memory
========================

${agentMemory}



========================
Workflow History
========================

${workflowHistory}



========================
Outputs from Other Agents
========================

${previousOutputs}



========================
QueryBuilder Search Strategy
========================

${queryBuilderOutput}


重要:

ResearcherはQueryBuilderが作成した
検索方針を参考にしてください。

ただし検索結果の正確性は
Tool結果とEvidenceを優先してください。



========================
Shared Evidence
========================

${evidenceSummary}


Evidenceには品質があります。

高品質Evidenceとは

・一次情報
・公式発表
・政府
・論文
・公式ドキュメント
・最新情報

です。


Evidenceを追加する場合は、
既存Evidenceより品質が高い場合のみ追加してください。

同じ内容のEvidenceは追加しないでください。


重要:

Shared Evidence は
TACTチームが共有する確認済み情報です。

AgentはEvidenceを優先してください。

存在しない事実を生成してはいけません。



========================
Tool Results
========================

${toolOutput}



重要:

Tool Resultsが存在する場合、

Tool実行は完了しています。

再度toolRequestsを返してはいけません。

Tool Resultsを利用して
最終JSONを完成してください。



========================
Agent Rules
========================

${agentRules[agentId]}

========================
Handoff
========================

あなたの成果物は、
次のAgentが利用します。

そのため、

・次のAgentが迷わないこと
・不足情報が分かること
・重要事項が分かること

を意識してください。

最後に必ず

handoff

を出力してください。

${outputFormat}`;

}