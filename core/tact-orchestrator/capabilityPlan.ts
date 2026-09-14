import type { TactIntent } from "../tact-intent/types";

// =========================
// TACT Orchestrator — Semantic-first Capability Planning (CAP-P1c)
// =========================
//
// PRODUCT MODEL(このphaseの明示的な設計、CAP-P1cの中核): 理想の
// 推論順序は
//
//   Task meaning → Canonical Capability(WHAT) → execution binding
//   (HOW、Capability Registry dispatch key) → Provider実行
//
// であり、「dispatch keyを先に選び、そこから意味論的Capabilityを
// 事後的に逆算する」(CAP-P1a/CAP-P1bまでの構造)ではない。
//
// Repository Reality Audit(実装前に実施)で判明した事実:
//   - core/tact-orchestrator/decomposer.tsのdecomposeTask()が、
//     TACT全体で唯一のTask Planner(Commander/Executorは分解結果を
//     そのまま消費するだけで、独自にTaskを生成しない)。
//   - decomposeTask()内部のsimple-task経路は、
//     core/tact-intent/ruleRouter.tsのclassifyIntent()が返す
//     TactIntent(8値のclosed union、core/tact-intent/types.ts)を、
//     三項演算子の連鎖でCapability Registry dispatch key
//     (例: "integration.gmail.search_messages")へ直接変換していた
//     ——この変換の時点で「このTaskは意味論的に何を必要とするか」を
//     一切明示的に経由しない。
//   - CAP-P1a/CAP-P1bのcore/tact-work/capability.tsの
//     resolveTaskCapabilities()は、既に確定したdispatch keyから
//     Canonical Capabilityを事後的に逆算するstatic mapを独自に
//     保持しており、この後述のCAPABILITY_BINDING_TABLEとは別の
//     独立したtableだった(値は一致していたが、2箇所で手動維持される
//     「重複した可変の真実」のリスクがあった)。
//   - Gmail send(execution binding: "integration.gmail.send_message")
//     は、decomposeTask()/classifyIntent()経由では到達しない
//     ——REF-P1fのcore/tact-conversation/orchestration.tsの
//     createGmailReferentApproval()が、既にApproval必須の別経路で
//     独立にこのbindingを使う。このtableはCapability/binding
//     compatibilityの参照先として、このbindingも含めて記述する
//     (Section9の要求)。
//
// 依存方向: core/tact-orchestrator/decomposer.tsは既に
// core/tact-intent/ruleRouter.tsへ依存している(classifyIntent())ため、
// このfileがcore/tact-intent/types.tsを型のみimportしても新しい依存
// 方向は生まれない。core/tact-work(このfileより上位の層)は、既存の
// 一方向依存(tact-work → tact-orchestrator)に従い、このfileを
// core/tact-orchestrator/index.ts経由でimportしてよい——逆方向
// (このfileがcore/tact-workを何か一つでもimportすること)は無い。
//
// 「重複した可変の真実を作らない」という絶対条件(CAP-P1c指示Section12)
// への対応: Canonical Capability ⇄ execution binding の対応関係を
// 定義する場所はこのfile 1箇所のみとする。core/tact-work/capability.ts
// (CAP-P1a/CAP-P1b)は、このfileが公開する
// resolveCapabilityForBinding()を呼ぶだけの薄いconsumerへ変更し
// (このcommitで変更)、独自のtableは削除する。

// =========================
// CanonicalCapabilityRequirement
// =========================
//
// core/tact-work/types.tsのCanonicalTaskCapability(WorkCapabilityRequirement
// | "research.perform")と全く同じ値集合を、独立して宣言する。
// cross-module importによる逆方向依存(tact-orchestrator →
// tact-work)を作らないための、core/tact-orchestrator/task.tsの
// TaskIntegrationRiskClassSnapshot等と同じ既存パターン
// (「値だけを独立に再宣言する」)。core/tact-work/types.tsの
// CanonicalTaskCapabilityは、このtableの値をそのまま使う消費者側の
// aliasとして扱う(値集合の一次的な定義元はこちら——Task Planning
// Layerが実際に決定を下す場所であるため)。
export type CanonicalCapabilityRequirement =
  | "organizational_context.read"
  | "communication.read"
  | "communication.write"
  | "research.perform";

export interface CapabilityPlan {

  // WHAT: このTaskが意味論的に必要とする能力。
  readonly capability: CanonicalCapabilityRequirement;

  // HOW: その能力を満たす、既存のCapability Registry dispatch key
  // (core/tact-core/capabilities/registry.tsへ登録された名前、または
  // "research"のような特別扱いの名前)。既存の実行経路は一切変更
  // しない——このfieldの値は、CAP-P1c以前からdecomposeTask()が
  // 生成していたassignedCapabilityの値と完全に同じ文字列を使う。
  readonly binding: string;

}

// =========================
// CAPABILITY_BINDING_TABLE (単一の真実の情報源)
// =========================
//
// 各entryはCanonical Capability・execution binding・(もしあれば)
// そのbindingへ到達するTactIntentの組を1箇所にまとめて記述する。
// planCapabilityForIntent()(計画時、TactIntent起点)と
// resolveCapabilityForBinding()/isBindingCompatibleWithCapability()
// (検証時、binding起点)の両方が、このentry配列だけを参照する
// ——2つの独立したtableを別々に手動維持しない。
//
// intents: 空配列は「この既存bindingはdecomposeTask()/classifyIntent()
// 経由では到達しないが、既存の実プロダクション実行経路として
// 現に存在する」ことを意味する(Gmail send、REF-P1f参照)。
interface CapabilityBindingEntry extends CapabilityPlan {
  readonly intents: readonly TactIntent[];
}

const CAPABILITY_BINDING_TABLE: readonly CapabilityBindingEntry[] = [

  {
    capability: "research.perform",
    binding: "research",
    intents: ["research"],
  },

  {
    capability: "communication.read",
    binding: "integration.gmail.search_messages",
    intents: ["integration_gmail_search_messages"],
  },

  // REF-P1f経由(createGmailReferentApproval())でのみ到達する既存の
  // 実行binding。classifyIntent()にこのbindingへ直接つながるTactIntent
  // は存在しない(Gmail送信はReferent解決 + Approval必須の専用経路)。
  {
    capability: "communication.write",
    binding: "integration.gmail.send_message",
    intents: [],
  },

  {
    capability: "communication.write",
    binding: "integration.slack.send_message",
    intents: ["integration_slack_send_message"],
  },

  {
    capability: "organizational_context.read",
    binding: "integration.slack.list_channels",
    intents: ["integration_slack_list_channels"],
  },

  {
    capability: "organizational_context.read",
    binding: "integration.notion.search",
    intents: ["integration_notion_search"],
  },

  {
    capability: "organizational_context.read",
    binding: "integration.notion.read_page",
    intents: ["integration_notion_read_page"],
  },

];

// =========================
// planCapabilityForIntent (Planning: Task meaning → Capability plan)
// =========================
//
// 絶対条件(compile-time exhaustiveness、Section7): TactIntentは
// core/tact-intent/types.tsで確定した8値のclosed unionである。
// Record<TactIntent, ...>という全key必須の型を経由することで、
// 「新しいTactIntentが追加されたのに、このtableへの対応を忘れる」
// ケースをTypeScriptのcompile errorとして検出する(実行時のsilent
// unresolvedではなく、実装時点で気づける形にする)。
// "chat"/"core_push"はCapability Registry dispatch自体を経由しない
// 既存の既定経路(chat Handler・将来のCore Push)であり、
// Capability要件を持たない——nullは「明示的に、Capability不要と
// 判定済み」を意味し、「未対応で埋め忘れた」という意味のundefinedとは
// 区別する。
const INTENT_TO_CAPABILITY_PLAN: Readonly<Record<TactIntent, CapabilityPlan | null>> = (() => {

  const byIntent = new Map<TactIntent, CapabilityPlan>();

  for (const entry of CAPABILITY_BINDING_TABLE) {
    for (const intent of entry.intents) {
      byIntent.set(intent, { capability: entry.capability, binding: entry.binding });
    }
  }

  const table: Record<TactIntent, CapabilityPlan | null> = {
    chat: null,
    core_push: null,
    research: byIntent.get("research") ?? null,
    integration_slack_send_message: byIntent.get("integration_slack_send_message") ?? null,
    integration_slack_list_channels: byIntent.get("integration_slack_list_channels") ?? null,
    integration_gmail_search_messages: byIntent.get("integration_gmail_search_messages") ?? null,
    integration_notion_search: byIntent.get("integration_notion_search") ?? null,
    integration_notion_read_page: byIntent.get("integration_notion_read_page") ?? null,
  };

  return table;

})();

// decomposeTask()がsimple-task経路で、classifyIntent()の結果から
// 最初に呼ぶ関数。intentがCapability Registry dispatchを必要としない
// 場合(chat/core_push)はnullを返す——これは失敗ではなく、「この
// Taskはそもそも意味論的Capabilityを必要としない」という正当な結果
// であり、Task自体はassignedCapability未設定のまま(既存のchat
// fallback、絶対条件: 既存挙動を変えない)として引き続き実行できる。
export function planCapabilityForIntent(intent: TactIntent): CapabilityPlan | null {
  return INTENT_TO_CAPABILITY_PLAN[intent];
}

// =========================
// resolveCapabilityForBinding / isBindingCompatibleWithCapability
// (Validation: execution binding ⇄ Canonical Capability)
// =========================
//
// binding起点の逆引き。core/tact-work/capability.tsのCAP-P1a/CAP-P1b
// 実行時representation(WorkTask.canonicalCapabilities/
// Run.canonicalCapabilities、既に永続化されたdispatch keyからの
// 事後導出)が、このfileと同じ単一tableを参照するために使う
// ——これにより「Planning時に決めた組」と「実行後に永続化された
// dispatch keyから逆算した組」が、常に同じ情報源から導かれる
// (絶対条件: 重複した可変の真実を作らない)。
export function resolveCapabilityForBinding(
  binding: string | null | undefined
): CanonicalCapabilityRequirement | undefined {

  if (!binding) {
    return undefined;
  }

  return CAPABILITY_BINDING_TABLE.find((entry) => entry.binding === binding)?.capability;

}

// Capability/binding compatibility check(CAP-P1c指示Section13、
// Section6のexample通り: communication.read + integration.gmail.
// search_messages = valid、communication.write + integration.gmail.
// search_messages = invalid)。Provider実行・外部書き込みは一切
// 発生しない、純粋な同期比較。
export function isBindingCompatibleWithCapability(
  capability: CanonicalCapabilityRequirement,
  binding: string | null | undefined
): boolean {

  return resolveCapabilityForBinding(binding) === capability;

}

// このtableが認識している既存execution binding一覧(診断・test用)。
// Capability Registryへの新しい登録機構ではない——既にプロダクションで
// 使われているdispatch keyの一覧を、このCanonical Capability
// compatibility tableがどこまで把握しているかを確認するための
// 読み取り専用ヘルパー。
export function listKnownExecutionBindings(): readonly string[] {
  return CAPABILITY_BINDING_TABLE.map((entry) => entry.binding);
}
