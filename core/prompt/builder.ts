import { tools } from "../tools";
import { Evidence } from "../context/types";
import { AgentId } from "../agents/types";
import { responsibilities } from "./responsibilities";
import { formatBrainMemory } from "../brain/memory";


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
  evidence: Evidence[] = [],
  mode: "quick" | "think" | "deep" = "think"
) {


const previousOutputs =
  outputs
    ? Object.keys(outputs).join(", ")
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



const workflowHistory = "Workflow omitted";


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



const evidenceText =
  evidence
    .map(e => e.claim)
    .join("\n");


// ==========================
// Agent別 Output Format
// ==========================

const outputFormats: Record<AgentId, string> = {

planner: `
========================
Planner Output Format
========================

{
  "goal":"",
  "category":"",
  "difficulty":"",
  "estimatedTime":"",
  "thinking":"",
  "reason":"",
  "plan":[]
}
`,

queryBuilder: `
========================
QueryBuilder Output Format
========================

{
  "intent":"",
  "searchTargets":[],
  "queries":[
    {
      "query":"",
      "priority":1
    }
  ],
  "reason":[]
}
`,

researcher: `
========================
Researcher Output Format
========================

{
  "toolRequests":[],
  "evidence":{
    "market":[],
    "competitors":[],
    "users":[],
    "businessModel":[],
    "features":[],
    "technology":[],
    "financial":[],
    "news":[],
    "other":[]
  },
  "missingInformation":[],
  "nextSearchSuggestions":[]
}
`,

designer: `
========================
Designer Output Format
========================

{
  "design":[],
  "assumptions":[]
}
`,

engineer: `
========================
Engineer Output Format
========================

{
  "architecture":[],
  "implementation":[]
}
`,

stakeholder: `
========================
Stakeholder Output Format
========================

{
  "value":[],
  "risks":[],
  "recommendations":[]
}
`,

reviewer: `
========================
Reviewer Output Format
========================

{
  "approved": true,
  "score": 92,
  "issues": [],
  "strengths": [],
  "improvements": [],
  "missingEvidence": []
}`,

writer: `
========================
Writer Output Format
========================

{
  "title":"",
  "summary":"",
  "answer":"",
  "nextActions":[]
}
`

};

const outputFormat = outputFormats[agentId];

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

${evidenceText}


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

Researcher

・事実だけ収集する
・Evidenceを増やす
・推測を書かない


Designer

・Evidenceを利用する


Engineer

・Evidenceを利用する


Stakeholder

・Evidenceを利用する


Reviewer

・Evidenceとの整合性を確認する


Writer

・Evidenceに存在しない事実を書かない



${outputFormat}

`;

}