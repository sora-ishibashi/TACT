import { tools } from "../tools";
import { Evidence, BrainRule } from "../context/types";
import { AgentId } from "../agents/types";
import { responsibilities } from "./responsibilities";
import { formatBrainMemory } from "../brain/memory";
import { outputFormats } from "./outputFormats";


const availableAgents = [
  "planner",
  "queryBuilder",
  "researcher",
  "analyst",
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


// Tool Results（生データ）をPromptへ埋め込むための整形。
// 検索結果のtitle/url/contentをそのまま渡すと長すぎるため、
// contentのみ一定文字数で要約（切り詰め）する。
const TOOL_RESULT_SNIPPET_LENGTH = 400;

function buildToolOutput(
  toolResults?: Record<string, unknown>
) {

  if (!toolResults || Object.keys(toolResults).length === 0) {
    return "None";
  }

  const lines: string[] = [];

  for (const results of Object.values(toolResults)) {

    if (!Array.isArray(results)) continue;

    for (const result of results as any[]) {

      const rawItems = result?.data?.raw;

      if (!Array.isArray(rawItems)) continue;

      for (const item of rawItems) {

        const title = item?.title ?? "";
        const url = item?.url ?? "";
        const content =
          typeof item?.content === "string"
            ? item.content
            : "";

        const snippet =
          content.length > TOOL_RESULT_SNIPPET_LENGTH
            ? content.slice(0, TOOL_RESULT_SNIPPET_LENGTH) + "..."
            : content;

        lines.push(`
Title: ${title}
URL: ${url}
Snippet: ${snippet}
`);

      }

    }

  }

  return lines.length > 0
    ? lines.join("\n")
    : "None";

}


// =========================
// buildEvidenceSummary (STEP35)
// =========================
//
// 背景: STEP32でuser_file(添付ファイル由来)Evidenceを既存の
// Evidence poolへ合流させたが、Shared Evidenceは常にフラットな
// 一覧としてPromptへ渡されており、AgentからはWeb由来Evidenceと
// 添付ファイル由来Evidenceを区別できなかった。実機テストで、
// Evidenceとして保持されてはいてもWriterが本文へ十分反映しない
// ケースが確認されたため、「ユーザーが今回のために直接提供した
// 一次資料」であることをテキスト上で明示する。
//
// 新しいEvidence種別・新しいスキーマは追加せず、既存の
// Evidence.sourceType(STEP32で追加済みの"user_file")で
// 分類するだけ。添付ファイルが存在しない場合(fileEvidenceが
// 空)は、従来と同じフラットな一覧表示のままとし、既存の
// 挙動・既存Prompt構造への影響を最小化する。

const EVIDENCE_SNIPPET_LENGTH = 500;

function formatEvidenceItem(e: Evidence): string {

  const body =
    typeof e.evidence === "string"
      ? e.evidence
      : "";

  const snippet =
    body.length > EVIDENCE_SNIPPET_LENGTH
      ? body.slice(0, EVIDENCE_SNIPPET_LENGTH) + "..."
      : body;

  return `
ID: ${e.id}
Claim: ${e.claim}
Source: ${e.source ?? "Unknown"}
Evidence: ${snippet || "（本文なし）"}
`;

}

function buildEvidenceSummary(
  evidence: Evidence[]
): string {

  const fileEvidence =
    evidence.filter(
      (e) => e.sourceType === "user_file"
    );

  const otherEvidence =
    evidence.filter(
      (e) => e.sourceType !== "user_file"
    );

  // 添付ファイルが存在しない場合は、従来どおりのフラットな一覧。
  if (fileEvidence.length === 0) {

    return evidence
      .map(formatEvidenceItem)
      .join("\n");

  }

  const parts: string[] = [];

  parts.push(
    `--- ユーザー添付資料由来のEvidence(${fileEvidence.length}件) ---\n` +
    "ユーザーが今回の作業のために直接提供した一次資料です。" +
    "今回の依頼に関連する内容であれば、成果物へ積極的に反映して" +
    "ください(資料に存在しない情報を追加することは禁止)。\n" +
    fileEvidence.map(formatEvidenceItem).join("\n")
  );

  if (otherEvidence.length > 0) {

    parts.push(
      `--- Web検索・その他由来のEvidence(${otherEvidence.length}件) ---\n` +
      otherEvidence.map(formatEvidenceItem).join("\n")
    );

  }

  return parts.join("\n\n");

}



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
  mode: "quick" | "think" | "deep" = "think",
  currentOutput?: unknown,
  // STEP147: 呼び出し元(core/workflow/runAgent.ts)が
  // WorkflowContext.brainMemory(このWorkflow専用のスナップショット、
  // core/workflow/index.tsのrefreshRelevantBrainMemory()戻り値)を
  // 明示的に渡す。省略時は空配列扱い(Brain Memoryなしでプロンプトを
  // 組み立てる。既存呼び出し元がまだ対応していない場合の後方互換)。
  brainMemoryEntries: BrainRule[] = []
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


// STEP12-A: 各Agentが生成したhandoff(次のAgentへの申し送り事項)を、
// 現在のAgentから見える範囲(visibleOutputsと同じ可視範囲)でPromptへ
// 反映する。handoffsの意味・型(Record<string, unknown>)・
// Workflow構造は変更せず、既に収集済みの値をテンプレートへ
// 差し込むだけの最小修正。
const previousHandoffs =
  handoffs
    ? visibleOutputs[agentId]
        .map((id) => {

          const handoff = handoffs[id];

          if (!handoff) return null;

          return `
========================
${id.toUpperCase()} Handoff
========================

${JSON.stringify(handoff, null, 2)}
`;

        })
        .filter(Boolean)
        .join("\n")
    : "None";


const toolOutput = buildToolOutput(toolResults);



  const agentMemory =
    memory && memory[agentId]?.length
      ? memory[agentId]
          .map((m) => `- ${m}`)
          .join("\n")
      : "None";



  // STEP4(Optimizer→Workflow接続): targetAgent付きの記憶は該当Agentの
  // プロンプトにだけ表示する(formatBrainMemory側のfilter)。
  // STEP147: formatBrainMemory()はもう共有状態を読まない純粋関数の
  // ため、このWorkflow用のスナップショット(brainMemoryEntries)を
  // 明示的に渡す。
  const brainMemory =
    formatBrainMemory(brainMemoryEntries, agentId);



// STEP35: フラット一覧の組み立ては、user_file/その他の区別を
// 明示するbuildEvidenceSummary()(このファイル冒頭で定義)へ集約した。
const evidenceSummary =
  buildEvidenceSummary(evidence);


// Conversationの2ターン目以降に渡される、直前のWriter出力(現在の成果物)。
// PlannerとWriterだけに見せる。ここでは新しい判断ロジックは実装せず、
// 「編集対象である」という位置づけをテキストで明示するのみ。
const currentOutputSection =
  (agentId === "planner" ||
    agentId === "writer") &&
  currentOutput
    ? `
========================
Current Output(現在の成果物・編集対象)
========================

${JSON.stringify(currentOutput, null, 2)}

重要:

これは過去の参考資料ではありません。

これはユーザーが現在作成中の成果物そのものです。

今回のユーザーの指示は、
この成果物をゼロから作り直すためのものではなく、
この内容を基準に必要な部分だけを更新するためのものです。

Plannerは、
今回の指示が「新規作成」なのか「既存成果物の更新」なのかを、
Current Outputの有無から判断してください。
Current Outputが存在する場合は「既存成果物の更新」として扱ってください。

Writerは、
Current Outputが存在する場合、
その内容を土台として更新後の完成版を作成してください。
Current Outputに含まれる情報を不必要に失わないでください。
ゼロから別の成果物を作らないでください。
`
    : "";


// STEP12-B: Writerが「現在の成果物を編集する」という責務を、
// JSON生成の直前(Prompt末尾)でも見失わないようにするための
// 補強セクション。currentOutputSection自体の位置・内容は変更せず、
// Writerにのみ、末尾で今回の具体的な要求とCurrent Outputへの
// 反映を改めて結びつける。Current Outputが存在しない初回Turnでは
// 空文字のままとし、不自然な編集指示にならないようにする。
const writerCurrentOutputReminder =
  agentId === "writer" && currentOutput
    ? `
========================
今回の編集指示(必ず反映)
========================

今回のユーザー要求:
${userInput}

この要求を、先に示したCurrent Output(現在の成果物・編集対象)へ
具体的に反映した上で、最終成果物のJSONを作成してください。

・要求に該当する箇所は、要求どおりに変更されているか
  出力前に必ず確認してください。
・要求されていない箇所は、Current Outputの内容をむやみに
  作り変えず維持してください。
・Current Outputが存在するにもかかわらず、
  無関係な新しい成果物を作ってはいけません。
`
    : "";



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
・Analystが整理した分析結果・方針をUI・UXへ落とし込む
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
Handoffs from Other Agents
========================

${previousHandoffs}

重要:

Handoffsは、各Agentが次のAgentへ向けて
明示的にまとめた申し送り事項です。

Outputs from Other Agentsの生データと合わせて、
次に何をすべきかの参考にしてください。



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

${currentOutputSection}

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

${writerCurrentOutputReminder}

${outputFormat}`;

}