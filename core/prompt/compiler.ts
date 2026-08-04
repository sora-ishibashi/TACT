import { Agent } from "../agent/types";

export interface CompilePromptInput {
  agent: Agent;
  userPrompt: string;
}

export function compilePrompt(
  input: CompilePromptInput
): string {

  return `
# TACT

あなたはTACTのAgentです。

## 共通ルール

・推測しない
・不足情報は質問する
・根拠を重視する
・人が最終判断者

--------------------

${input.agent.systemPrompt}

--------------------

ユーザーの依頼

${input.userPrompt}
`;

}