import { buildPrompt } from "../prompt/builder";
import { runLLM } from "../llm";
import { executeToolCalls } from "../tools/executeToolCalls";
import { retrieveEvidence } from "../evidence/retrieveEvidence";
import { Agent } from "../agent/types";
import fs from "fs";
import path from "path";
import { Evidence } from "../context/types";

function cleanJSON(text: string) {
  return text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function saveAgentLog(
  agentId: string,
  data: unknown
) {

  const logDir =
    path.join(
      process.cwd(),
      "logs"
    );

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }

  const fileName =
    `${Date.now()}-${agentId}.json`;

  fs.writeFileSync(

    path.join(
      logDir,
      fileName
    ),

    JSON.stringify(
      data,
      null,
      2
    )

  );

}

export async function runAgent(
  agent: Agent,
  step: any,
  context: any
) {

  context.logs.push({
    type: "start",
    agent: agent.id,
    timestamp: new Date().toISOString(),
  });

  console.log("\n====================================");
  console.log(`${agent.name} START`);
  console.log(`Task : ${step.task}`);
  console.log("====================================");

let toolResults: Record<string, unknown> = {};


// ===============================
// QueryBuilder Output
// ===============================

const queryBuilderOutput =
  context.outputs.queryBuilder ?? null;

const shouldRetrieveEvidence =
  [
    "designer",
    "engineer",
    "stakeholder",
    "reviewer",
    "writer",
  ].includes(agent.id);

const evidenceQueryByAgent = {

researcher: [
  context.userInput,
  step.task,
  context.outputs.queryBuilder
    ? JSON.stringify(context.outputs.queryBuilder)
    : "",
]
.filter(Boolean)
.join(" "),

designer: [
  context.userInput,
  step.task,
  "UI UX layout flow",
]
  .filter(Boolean)
  .join(" "),

engineer: [
  context.userInput,
  step.task,
  "API DB architecture implementation",
]
  .filter(Boolean)
  .join(" "),

stakeholder: [
  context.userInput,
  step.task,
  "value risk user business",
]
  .filter(Boolean)
  .join(" "),
  
reviewer: [
  context.userInput,
  step.task,
  "consistency quality gaps",
]
  .filter(Boolean)
  .join(" "),

writer: [
  context.userInput,
  step.task,
  "final output summary structure",
]
  .filter(Boolean)
  .join(" "),

} as Record<string, string>;

const relevantEvidence =
  shouldRetrieveEvidence
    ? retrieveEvidence(
        context.evidence,
        evidenceQueryByAgent[agent.id] ??
          `${context.userInput} ${step.task}`,
        10
      )
    : context.evidence;

  // ===============================
  // 1回目
  // ===============================

  let response = await runLLM({


    provider: agent.provider,

    systemPrompt: agent.systemPrompt,

    userPrompt: buildPrompt(
      agent.id,
      context.userInput,
      step.task,
      context.outputs,
      context.stepOutputs,
      toolResults,
      context.memory,
      relevantEvidence,
      context.mode
    ),

  });


  console.log("====================================");
  console.log("RAW RESPONSE (1)");
  console.dir(response, { depth: null });
  console.log("====================================");


  let cleaned = cleanJSON(
    response.content ?? ""
  );


  if (!cleaned) {

    throw new Error(
      `${agent.id} returned empty response.`
    );

  }


  let parsed: any;


  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    console.error("JSON Parse Error");
    console.error(response.content);
    throw error;

  }

  if (
    agent.id === "planner" &&
    parsed.toolRequests
  ) {

    console.warn(
      "Planner returned toolRequests. Ignoring."
    );

    delete parsed.toolRequests;

  }


  // ===============================
  // Tool Requests
  // ===============================

  if (
    agent.tools.length > 0 &&
    Array.isArray(parsed.toolRequests) &&
    parsed.toolRequests.length > 0
  )  
  {

    console.log("Executing Tool Requests...");


    toolResults =
      await executeToolCalls(
        parsed.toolRequests,
        context.userInput
      );


    // ===============================
    // Tool Evidence共有
    // ===============================

for (const toolOutputs of Object.values(toolResults)) {

  if (!Array.isArray(toolOutputs)) continue;

  for (const toolResult of toolOutputs as any[]) {

    if (
      toolResult?.data?.evidence &&
      Array.isArray(toolResult.data.evidence)
    ) {

      context.evidence.push(
        ...toolResult.data.evidence
      );

    }

  }

}

    console.log("Re-running with Tool Results...");


    response = await runLLM({

      provider: agent.provider,

      systemPrompt: agent.systemPrompt,

      userPrompt:
        buildPrompt(
          agent.id,
          context.userInput,
          step.task,
          context.outputs,
          context.stepOutputs,
          toolResults,
          context.memory,
          relevantEvidence,
          context.mode
        ) +
        `

重要：

Tool実行は完了しています。

Tool Results を利用して、
あなた本来のJSONを完成させてください。

toolRequestsだけを返して終了してはいけません。

toolRequestsは必ず空配列にしてください。

`,

    });


    console.log("====================================");
    console.log("RAW RESPONSE (2)");
    console.dir(response, { depth: null });
    console.log("====================================");


    cleaned = cleanJSON(
      response.content ?? ""
    );


    if (!cleaned) {

      throw new Error(
        `${agent.id} returned empty response.`
      );

    }


    try {

      parsed = JSON.parse(cleaned);

    } catch (error) {

      console.error("JSON Parse Error");
      console.error(response.content);
      throw error;

    }

  }


  console.log(
    `Parsed Output (${agent.id})`
  );


  console.log(
    JSON.stringify(parsed, null, 2)
  );

  saveAgentLog(
  agent.id,
  {

    prompt: buildPrompt(
      agent.id,
      context.userInput,
      step.task,
      context.outputs,
      context.stepOutputs,
      toolResults,
      context.memory,
      relevantEvidence,
      context.mode
    ),

    response,

    parsed,

    evidence:
      relevantEvidence,

    toolResults

  }
);

  // ===============================
  // 保存
  // ===============================

context.outputs[agent.id] = parsed;

if (agent.id === "reviewer") {
  context.reviewHistory.push(parsed);
}

context.stepOutputs[step.id] = {

  agent: agent.id,

  output: parsed,

};

if (agent.id === "reviewer") {
  context.reviewHistory.push(parsed);
}

if (
  agent.id === "reviewer" &&
  Array.isArray(parsed.improvements)
) {

for (const improvement of parsed.improvements) {

  const lower = improvement.toLowerCase();

  let target = "reviewer";

  if (lower.includes("research")) {
    target = "researcher";
  }

  else if (lower.includes("design")) {
    target = "designer";
  }

  else if (lower.includes("engineer")) {
    target = "engineer";
  }

  else if (lower.includes("stakeholder")) {
    target = "stakeholder";
  }

  else if (lower.includes("planner")) {
    target = "planner";
  }

  else if (lower.includes("writer")) {
    target = "writer";
  }

  context.memory[target] ??= [];

  context.memory[target].push({
    rule: improvement,
    reason: "Generated by Reviewer",
    priority: "medium",
    createdAt: Date.now(),
  });

}
}

// ===============================
// Researcher Evidence 保存
// ===============================

if (
  agent.id === "researcher" &&
  parsed.evidence
) {

  for (const category of Object.keys(parsed.evidence)) {

    const items = parsed.evidence[category];

    if (!Array.isArray(items)) continue;

    for (const item of items) {

      const hash =
        (
          (item.name ??
            item.topic ??
            item.feature ??
            item.metric ??
            item.segment ??
            item.model ??
            item.headline ??
            "") +
          JSON.stringify(item)
        ).toLowerCase();

      const exists =
        context.evidence.some(
          (e: Evidence) => e.hash === hash
        );

      if (exists) continue;

      context.evidence.push({

        id: crypto.randomUUID(),

        claim:
          item.name ??
          item.topic ??
          item.feature ??
          item.metric ??
          item.segment ??
          item.model ??
          item.headline ??
          "Unknown",

        evidence: JSON.stringify(item),

        source:
          Array.isArray(item.sources)
            ? item.sources.join(", ")
            : item.sources,

        confidence:
          item.confidence >= 0.9
            ? "high"
            : item.confidence >= 0.7
            ? "medium"
            : "low",

        score: 0,

        hash,

        createdBy: "researcher",

        createdAt: Date.now(),

        tags: [category],

      });

    }

  }

}

context.logs.push({

    type: "finish",

    agent: agent.id,

    output: parsed,

    timestamp: new Date().toISOString(),

  });


  console.log(
    `${agent.name} COMPLETE`
  );


  return parsed;

}