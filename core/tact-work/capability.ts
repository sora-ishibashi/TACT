import type { CanonicalTaskCapability, Work, WorkCapabilityRequirement, WorkTask } from "./types";
// CAP-P1c: Canonical Capability ⇄ execution binding compatibility
// tableの単一の真実の情報源はcore/tact-orchestrator/capabilityPlan.ts
// (Task Planning Layer、意味論的Capabilityが実際に決定される場所)へ
// 移した。core/tact-workは既存の一方向依存(tact-work →
// tact-orchestrator)に従い、それを消費するだけの薄いwrapperになる
// ——このfileが独自に別のTASK_CAPABILITY_MAPを保持すると、2箇所を
// 手動で同期し続けねばならない「重複した可変の真実」になるため、
// CAP-P1c指示Section12によりそれを廃止する。
import { resolveCapabilityForBinding } from "../tact-orchestrator";

// =========================
// TACT Work — Canonical Capability Router (CAP-P1)
// =========================
//
// PRODUCT MODEL(このphaseの明示的な設計): 理想の順序は
// Task → Capability → Provider → Run。TACTの判断はprovider-first
// (「Gmailを使う」)ではなく、capability-first(「このTaskには何の能力が
// 必要か」)であるべき——ただしこのphaseはTask → Capabilityの
// canonical化にとどめ、Provider selectionの高度化(最適Provider
// ランキング・cost最適化・dynamic marketplace等)は一切行わない。
//
// Repository Reality Audit(実装前に実施、結果は完了報告に記載)で
// 判明した事実:
//   - core/tact-core/capabilities/registry.tsのregisterCapability()は
//     「名前→handler」のService Locatorであり、Canonical Capability
//     taxonomyではない。登録されている名前("research"・"design"・
//     "integration.slack.send_message"等)は、Capability Registry
//     dispatch key(実行時にどのhandlerを呼ぶか)であって、
//     このphaseが求める意味論的Capability("communication.write"等)
//     とは別物。
//   - "integration.gmail.send_message"のようなdispatch keyには、
//     provider名(gmail)がcapability名の一部として混入している
//     (このphaseのBAD例そのもの)。
//   - core/tact-work/types.tsのWorkCapabilityRequirement
//     ("organizational_context.read" | "communication.read" |
//     "communication.write")は、provider名を含まない既に確立済みの
//     canonical vocabulary(resolveDelegatedWorkIntent()がWork.
//     requiredCapabilitiesへ書き込む値)。ただしDB制約
//     (tact_works_required_capabilities_array_check、supabase/
//     migrations/20260921000000_add_gmail_work_semantics.sql)により、
//     Work.requiredCapabilitiesへ実際に永続化できる値はこの3つに
//     厳密に限定されている。
//   - "research"(Research Capability)は、上記3値のいずれにも
//     該当しない別種の能力(外部Web調査+統合)であり、現状
//     Work.requiredCapabilitiesへ一切書き込まれない(Research意図の
//     WorkはresolveDelegatedWorkIntent()を経由しないため)。
//
// 設計判断(絶対条件、schema変更を避けるための選択): DB制約付きの
// WorkCapabilityRequirement型自体は変更しない(migration不要)。
// 代わりに、このfile内だけで完結するCanonicalCapability型
// (WorkCapabilityRequirementのsuperset + "research.perform")を新設し、
// Task/Run側の分類・集約という「読み取り専用の付加情報」にのみ使う。
// Work.requiredCapabilitiesへの書き込み経路(resolveDelegatedWorkIntent()、
// core/tact-work/delegatedIntent.ts)はこのphaseで一切変更しない
// ——"research.perform"がWork.requiredCapabilitiesへ書き込まれることは
// 構造的に無い(このfileにWork書き込みの関数が存在しない)。

// CAP-P1b: 値集合の単一の真実の情報源(source of truth)は
// core/tact-work/types.tsのCanonicalTaskCapabilityへ移した
// (WorkTask.canonicalCapabilities/Run.canonicalCapabilitiesという
// domain型のfieldとして正式に使うため)。このfileの既存の
// CanonicalCapabilityという名前は、既存の呼び出し元(このfile自身の
// 関数群・既存test)を壊さないためのaliasとしてそのまま維持する。
export type CanonicalCapability = CanonicalTaskCapability;

// TIME-P1c (Section 5, capability audit): "calendar.availability.read"
// added the same way "research.perform" was — see its definition in
// core/tact-work/types.ts for why no DB migration was needed.
export const CANONICAL_CAPABILITIES: readonly CanonicalCapability[] = [
  "organizational_context.read",
  "communication.read",
  "communication.write",
  "research.perform",
  "calendar.availability.read",
];

// =========================
// resolveTaskCapabilities (Router: Task → Capability)
// =========================
//
// 絶対条件(DETERMINISM / LLM BOUNDARY): 既知のWorkTask.assignedCapability/
// Run.capability文字列(core/tact-orchestrator/decomposer.tsのTask
// 生成、core/tact-work/execution.tsのcreateTask()/createRun()経由で
// 既に確定しているcanonical dispatch key)から、決定論的な
// resolveCapabilityForBinding()(core/tact-orchestrator/
// capabilityPlan.ts、CAP-P1c)だけでCanonical Capabilityへ変換する。
// LLMは一切使わない。
//
// 絶対条件(fail closed、未知Capabilityを勝手に生成しない): tableに
// 存在しないdispatch key(将来のprovider追加等で未登録のまま)には
// undefinedを返す——推測でCanonical Capabilityを埋めない。呼び出し元は
// これを「まだこのdispatch keyのcapability分類が定義されていない」と
// 解釈する(例外を投げない、既存の防御的パターンを踏襲)。
//
// 絶対条件(CAPABILITY CARDINALITY): 1 dispatch key = 1 Capabilityに
// 永久固定しない——将来1 Taskが複数Capabilityを必要とする場合に
// 備え、戻り値は常に配列とする(現時点ではどのdispatch keyも1件のみ、
// resolveCapabilityForBinding()自体は単一値を返す)。
export function resolveTaskCapabilities(
  assignedCapability: string | null | undefined
): readonly CanonicalCapability[] | undefined {

  if (!assignedCapability) {
    // 絶対条件: assignedCapability未設定(chat fallback等)は「能力
    // 不要」であり「未知」ではない——空配列(既知だが要件ゼロ)ではなく
    // undefined(この関数の入力自体が意味を持たない)を返すことで、
    // 「未知のdispatch key」(tableに無いkey、こちらもundefined)と
    // 区別しない——両者とも「Capability要件を主張しない」という
    // 同じ安全側の扱いにとどめる(絶対条件: 過剰な区別を増やさない)。
    return undefined;
  }

  const capability = resolveCapabilityForBinding(assignedCapability);

  return capability ? [capability] : undefined;

}

// =========================
// summarizeTaskCapabilities (Task-level → Work aggregate projection)
// =========================
//
// WORK.requiredCapabilities関係(このphaseの明示的要求、Section10):
// 「Task capability requirements → Work aggregate capability
// requirements」という一方向のprojectionとして提供する。read-onlyな
// 集約であり、Work.requiredCapabilities自体を書き換えない
// (Work作成時の既存書き込み経路、resolveDelegatedWorkIntent()は
// 一切変更しない)。
export function summarizeTaskCapabilities(
  tasks: readonly Pick<WorkTask, "assignedCapability">[]
): readonly CanonicalCapability[] {

  const seen = new Set<CanonicalCapability>();

  for (const task of tasks) {

    const resolved = resolveTaskCapabilities(task.assignedCapability);

    if (!resolved) {
      continue;
    }

    for (const capability of resolved) {
      seen.add(capability);
    }

  }

  return Array.from(seen);

}

// =========================
// findUndeclaredTaskCapabilities (drift検出、非enforcing)
// =========================
//
// 絶対条件(Section16、最重要): これはWork completion判定にも
// Approvalにも一切接続しない、純粋な診断用ヘルパーである。
// Work.requiredCapabilities(Work作成時点で確定した既存の宣言)と、
// 実際にこのWorkの下で使われたTaskのCapability集合を比較し、
// 「宣言されていなかったCapability」を返すだけ——何かをblockしたり、
// WorkやTaskの状態を変更したりは一切しない(呼び出し自体が完全に
// side-effect free)。
//
// 絶対条件: WorkCapabilityRequirement(DB制約付き3値)に存在しない
// Canonical Capability(例: "research.perform"、TIME-P1cで追加された
// "calendar.availability.read")は、そもそもWork.requiredCapabilitiesへ
// 書き込めない値のため、比較対象から自然に除外する(型レベルで
// WorkCapabilityRequirementのみを見る)。
const NON_WORK_CAPABILITY_REQUIREMENTS: ReadonlySet<CanonicalCapability> = new Set([
  "research.perform",
  "calendar.availability.read",
]);

export function findUndeclaredTaskCapabilities(
  work: Pick<Work, "requiredCapabilities">,
  tasks: readonly Pick<WorkTask, "assignedCapability">[]
): readonly WorkCapabilityRequirement[] {

  const declared = new Set(work.requiredCapabilities ?? []);

  const used = summarizeTaskCapabilities(tasks).filter(
    (capability): capability is WorkCapabilityRequirement => !NON_WORK_CAPABILITY_REQUIREMENTS.has(capability)
  );

  return used.filter((capability) => !declared.has(capability));

}
