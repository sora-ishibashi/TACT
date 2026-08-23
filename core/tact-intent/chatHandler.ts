import { runLLM } from "../llm";
import type { Provider } from "../agent/types";
import type { CoreContext } from "../tact-core/context/types";

// =========================
// runChat (STEP216、Phase 7でProvider/Model上書き、Phase 9でMemory-aware化)
// =========================
//
// Intent Routerが"chat"と判定した入力に対する、最小のChat Handler。
// core/tact-research/llmAnswer.tsのgenerateLLMAnswer()と同じ前例
// (STEP180絶対条件)を踏襲し、core/llm/index.tsのrunLLM()を直接
// 呼び出す。core/llm/runLLMWithFallback.ts(Legacy Workflowのための
// フォールバック層)は使わない。core/conversation/runConversationTurn()・
// core/workflow/runWorkflow()・core/agents配下のAgent system prompt群も
// 一切使わない(STEP216絶対条件: Legacy Workflowへの新規依存を作らない)。
//
// modelTier/ExecutionStrategy/Brainには依存しない。
//
// Phase 7: TACT Orchestrator(core/tact-orchestrator/modelRouter.ts)が
// Task.assignedProvider/assignedModelから解決したProvider/Modelを
// 明示的に渡せるよう、第2引数にoptions(省略可能)を追加した。省略時
// (既存呼び出し元app/api/tact/chat/route.ts含む)は、STEP216時点と
// 完全に同じ挙動("openai"固定、model省略→Provider実装側の既定モデル
// "gpt-4o-mini")を維持する(破壊的変更ではない)。
//
// Phase 9: Phase 8 Reality Testで「chat TaskはCore Memoryを一切参照
// できない」ことが実際のユーザー価値の欠落として確認されたため、
// options.contextでCoreContext(core/tact-core/context/types.ts、既存
// 型そのまま)を受け取れるようにした。絶対条件8: Chat Handler自身は
// retrievalを一切行わない(Supabase/CoreCapabilityへアクセスしない)。
// 渡されたcontextをsystem promptへ整形するだけ。retrievalの責務は
// 呼び出し元(core/tact-orchestrator/taskContext.tsのbuildTaskContext())
// に一元化されたまま。省略時(既存呼び出し元含む)はcontextを付加せず、
// 従来と全く同じsystem promptのまま動作する(破壊的変更ではない)。
//
// DI(runLLMImpl)について: generateLLMAnswer()と同じ確立済みパターン。
// テストでモックを注入できるようデフォルト引数として受け取る。本番
// 呼び出し元(app/api/tact/chat/route.ts)はこの引数を省略する。

const CHAT_SYSTEM_PROMPT =
  "あなたはTACTです。ユーザーと自然に会話してください。" +
  "簡潔に、親しみやすい日本語で答えてください。" +
  "事実の裏取りが必要な質問には深入りせず、必要であれば" +
  "「詳しく調べてほしい場合はそう伝えてください」と伝えてください。";

export interface RunChatOptions {

  provider?: Provider;

  model?: string;

  // Phase 9: Task単位で絞り込み済みのCoreContext
  // (core/tact-orchestrator/taskContext.tsのbuildTaskContext()が
  // 構築したもの)。呼び出し元がRetrieval済みの結果を渡すだけであり、
  // ここでは一切のretrieval・絞り込みロジックを持たない(絶対条件8)。
  // 省略、または3種とも空配列の場合は既存(STEP216)と同じsystem
  // promptのまま動作する。
  context?: CoreContext;

}

// STEP216のCHAT_SYSTEM_PROMPTを変更せず、関連情報がある場合のみ末尾に
// 追記する形にする(絶対条件9: 既存呼び出し元との後方互換性維持。
// options省略時はこの関数が呼ばれても空文字を返すだけで、system
// promptは一切変化しない)。core/tact-research/contextAssembly.tsの
// ような専用のContext Assembly層は今回新設しない(絶対条件17: 最小
// 変更、Research用の複雑なAssembly構造をChatへ持ち込まない)。単純な
// 箇条書き整形のみ。
function formatCoreContextForChat(
  context: CoreContext | undefined
): string {

  if (!context) {
    return "";
  }

  const sections: string[] = [];

  if (context.knowledge.length > 0) {

    sections.push(
      "関連する知識:\n" +
      context.knowledge
        .map((item) => `- ${item.title}: ${item.content}`)
        .join("\n")
    );

  }

  if (context.memories.length > 0) {

    sections.push(
      "関連する記憶:\n" +
      context.memories.map((item) => `- ${item.content}`).join("\n")
    );

  }

  if (context.examples.length > 0) {

    sections.push(
      "参考になる過去の例:\n" +
      context.examples
        .map((item) => `- ${item.title}${item.description ? `: ${item.description}` : ""}`)
        .join("\n")
    );

  }

  if (sections.length === 0) {
    return "";
  }

  return (
    "\n\n以下はこのユーザーに関するTACT Coreの参考情報です。" +
    "関連する場合のみ回答に活用し、関連しない場合は無視してください:\n\n" +
    sections.join("\n\n")
  );

}

export async function runChat(
  input: string,
  options?: RunChatOptions,
  runLLMImpl: typeof runLLM = runLLM
): Promise<string> {

  const response = await runLLMImpl({

    // STEP216時点の既定("openai"固定)を、options省略時にそのまま
    // 維持する。
    provider: options?.provider ?? "openai",

    model: options?.model,

    systemPrompt:
      CHAT_SYSTEM_PROMPT + formatCoreContextForChat(options?.context),

    userPrompt: input,

    // STEP216: Chat Handlerは自然文で応答する(既存Agent群のJSON応答
    // 前提とは異なる、core/tact-research/llmAnswer.tsのJSON modeとも
    // 異なる)。responseFormat省略時の既定はJSON modeのため、ここでは
    // 明示的に"text"を指定する。
    responseFormat: "text",

  });

  return response.content;

}
