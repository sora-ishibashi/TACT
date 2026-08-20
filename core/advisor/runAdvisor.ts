// =========================
// runAdvisor (STEP28)
// =========================
//
// Advisorは、core/workflow(runWorkflow/runAgent)の実行ステップには
// 参加しない、独立したQ&A専用の処理。既存のreconstructTask.tsと
// 同じく、runLLM()を直接1回呼び出すだけの軽量な実装とする。
//
// 責務:
// 「現在のConversationが実際に持っている情報(成果物・Evidence・
// Workflow実行履歴)をもとに、ユーザーの質問に回答する」
// ことだけ。成果物の生成・変更、Workflow実行、Evidence収集は
// 一切行わない。

import { runLLM } from "../llm";
import {
  Conversation,
  ConversationAttachment,
} from "../conversation/types";
import { ADVISOR_SYSTEM_PROMPT } from "./systemPrompt";
import { buildAdvisorContext } from "./buildAdvisorContext";

const FALLBACK_ANSWER =
  "申し訳ありません、現時点の記録から回答を生成できませんでした。";

export async function runAdvisor(
  conversation: Conversation,
  userInput: string,
  // STEP32: AdvisorはWorkflow(seedEvidence/Evidence pool)を経由
  // しないため、今回のTurnで添付されたファイルの内容を直接受け取り、
  // buildAdvisorContext()へそのまま渡す。省略時(既存の呼び出し)の
  // 挙動は変わらない。
  attachments?: ConversationAttachment[],
  // STEP39: requestType(task/question)とは独立した軸。
  // "idea"の場合のみ、成果物の説明ではなく「アイデアの壁打ち・
  // 批評・別案提示」に適した回答を促す追加指示を差し込む。
  // 省略時(既存の呼び出し)は従来どおり"evidence"として扱う。
  conversationMode: "evidence" | "idea" = "evidence"
): Promise<string> {

  const context = buildAdvisorContext(conversation, attachments);

  const ideaModeGuidance =
    conversationMode === "idea"
      ? `

========================
今回の質問の性質(Idea Mode)
========================

この質問は、既存の成果物についての事実確認ではなく、
アイデアの壁打ち・批評・別案の検討を求めている可能性があります。

単純な賛成/反対や説明だけで終わらせず、可能な範囲で以下の
観点を整理して回答してください。

・強み
・弱み・懸念点
・前提としていること
・リスク
・改善案や別の方向性
・次に確認・検証すべきこと

ただし、これは成果物の内容を書き換える指示ではありません。
回答はあくまでチャット上の会話であり、成果物(currentOutput)は
変更しないでください。

また、Evidenceで裏付けられていない仮説・アイデアを、確認済みの
事実であるかのように断定して答えないでください。仮説は仮説として、
アイデアはアイデアとして述べてください。
`
      : "";

  const userPrompt = `
${context}
${ideaModeGuidance}
========================
ユーザーからの質問
========================

${userInput}
`.trim();

  const response = await runLLM({

    provider: "openai",

    systemPrompt: ADVISOR_SYSTEM_PROMPT,

    userPrompt,

    // Advisorはチャット上でユーザーへ直接見せる自然文の回答を
    // 生成するため、他Agent/Task Reconstructionと異なりJSON modeを
    // 使わない。
    responseFormat: "text",

  });

  const answer = response.content?.trim();

  return answer || FALLBACK_ANSWER;

}
