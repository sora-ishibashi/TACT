import { getModelPricing } from "../llm/pricing";
import type { Provider } from "../agent/types";
import type { Task } from "./task";

// =========================
// resolveModelRouting (Phase 7)
// =========================
//
// 責務を極めて限定する(STEP2): Task → resolveProvider() →
// resolveModel() → Provider/Model、だけ。Task decomposition・
// Memory Retrieval・Capability実行・Aggregationはここへ一切持ち込まない
// (それぞれdecomposer.ts/taskContext.ts/executor.ts/aggregator.tsの
// 既存責務のまま)。
//
// LLM-based Routingは行わない(絶対条件1)。以下の決定論的な優先順位
// だけで解決する(STEP3):
//   ① Taskに明示されたassignedProvider/assignedModel
//   ② Capabilityごとの既定Provider(下のCAPABILITY_DEFAULT_PROVIDER、
//      既存のcore/tact-research/llmAnswer.ts・
//      core/tact-intent/chatHandler.tsが既に持っているデフォルト値を
//      "反映するだけ"であり、ここで新しい判断は発明しない)
//   ③ TACT全体の既定(TACT_DEFAULT_PROVIDER)
//
// Modelについては②③の「既定Model」テーブルを持たない(絶対条件:
// 存在しない情報を推測しない)。①が無ければmodelはundefinedのまま
// 返し、各Provider実装(core/llm/providers/openai.ts等)が既に持つ
// 既定モデルへ自然にフォールバックさせる(既存挙動を変えない、新しい
// 重複したデフォルト値をここに作らない)。

export type ModelRoutingOutcome =
  | { success: true; provider: Provider; model?: string }
  | { success: false; error: string };

// STEP6: Capability固有の判断をModel Router内部に大量に書かない
// (悪い例: if research then X, if design then Y ...という条件分岐の
// 集積)。ここは条件分岐ではなく、既存実装の既定値を写した宣言的な
// テーブルに留める。
//   research → core/tact-research/llmAnswer.tsのgenerateLLMAnswer()の
//              デフォルト引数(provider: Provider = "openai")と同じ値。
// chatはCapability未割当(Task.assignedCapability === undefined)のため
// このテーブルには現れず、③のTACT全体既定へ自然にフォールバックする
// (chatHandler.tsの既存既定"openai"と同じ値になる、これも偶然の一致
// ではなく意図的に揃えている)。
const CAPABILITY_DEFAULT_PROVIDER: Readonly<Record<string, Provider>> = {

  research: "openai",

};

// core/llm/executionStrategy.tsのExecutionStrategy(STEP157)は
// core/workflow/taskProfile.ts(Legacy Workflow)へ依存しているため
// 再利用しない(絶対条件3: Legacy Workflowへの実importを増やさない)。
// TACT全体の既定Providerは、ここで独立して1箇所だけ定義する。
const TACT_DEFAULT_PROVIDER: Provider = "openai";

// core/llm/index.tsのswitch文(STEP157/166)と一致させる、実装済み
// Provider一覧。"gemini"は型(core/agent/types.tsのProvider)としては
// 存在するが、STEP166時点でruntime実装が無く、呼び出すと
// core/llm/index.ts側が明示的にErrorを投げる(未実装であることを
// 隠さない、という既存設計方針をここでも踏襲する)。
const IMPLEMENTED_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>([
  "openai",
  "claude",
]);

const KNOWN_PROVIDER_VALUES: ReadonlySet<string> = new Set<string>([
  "openai",
  "claude",
  "gemini",
]);

function isKnownProviderValue(value: string): value is Provider {

  return KNOWN_PROVIDER_VALUES.has(value);

}

// STEP3: ①明示指定 → ②Capability既定 → ③TACT既定、の優先順位。
// 戻り値をstringにしているのは、①の値が(型上はProviderのはずだが)
// 不正なcast等により実際には未知の文字列である可能性を、この関数の
// 型だけでは排除できないため(resolveModelRouting()側で検証する)。
function resolveProviderValue(task: Task): string {

  if (task.assignedProvider) {
    return task.assignedProvider;
  }

  const capabilityDefault = task.assignedCapability
    ? CAPABILITY_DEFAULT_PROVIDER[task.assignedCapability]
    : undefined;

  return capabilityDefault ?? TACT_DEFAULT_PROVIDER;

}

// STEP4: Provider/Modelの不整合を検知する。既存core/llm/pricing.ts
// (STEP159/166で実在・料金を確認済みのmodelだけを載せる、という既存の
// 安全設計)を「そのモデルが別Providerに属することが確定している」
// 判定の根拠として再利用する。
//
// 重要(絶対条件: 存在しない価格・レイテンシ情報を推測しない):
// pricing.tsに載っていないmodel(価格未確認だが実在するモデル、
// 例: claude-sonnet-5/claude-opus-5、core/llm/providers/claude.ts
// 冒頭コメント参照)は「不正」とは判断しない。「別Providerのモデルだと
// 確定している」場合だけをmismatchとして扱う(known-badチェックであり
// known-goodアローリストではない)。
function detectConfirmedProviderModelMismatch(
  provider: Provider,
  model: string
): string | undefined {

  const otherProviders = (["openai", "claude"] as Provider[]).filter(
    (candidate) => candidate !== provider
  );

  for (const other of otherProviders) {

    if (getModelPricing(other, model)) {

      return (
        `model "${model}" is a confirmed "${other}" model ` +
        `(core/llm/pricing.ts), not a "${provider}" model. ` +
        "Refusing to silently switch providers."
      );

    }

  }

  return undefined;

}

export function resolveModelRouting(
  task: Task
): ModelRoutingOutcome {

  const providerValue = resolveProviderValue(task);

  if (!isKnownProviderValue(providerValue)) {

    return {
      success: false,
      error: `unknown provider "${providerValue}" (not one of: openai, claude, gemini)`,
    };

  }

  if (!IMPLEMENTED_PROVIDERS.has(providerValue)) {

    return {
      success: false,
      error: `provider "${providerValue}" is not implemented yet (core/llm/index.ts)`,
    };

  }

  const model = task.assignedModel;

  if (model) {

    const mismatch = detectConfirmedProviderModelMismatch(providerValue, model);

    if (mismatch) {
      return { success: false, error: mismatch };
    }

  }

  return { success: true, provider: providerValue, model };

}
