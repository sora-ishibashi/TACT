// =========================
// TACT Runtime — Provider-Neutral Runtime Adapter Foundation
// (Fast Port P5a)
// =========================
//
// 目的(P5a Goal): P2〜P4で確立したTACT canonical control plane
// (Work/Task/Run/Policy/Approval/Clarification/Audit)を一切変更せず、
// 「durable executionをどう実行するか」というExecution Runtime関心を
// 分離するための、provider-neutralな最小contractだけをここへ置く。
//
// Prior Art(Execution Runtime Comparative Review、2026-09-08。
// docs/prior-art/execution-runtime-comparative-review.md /
// docs/architecture/p2-p5-final-architecture.md Section21-25。
// ADAPT_AND_BORROW、source codeはコピーしない): Trigger.dev
// (Apache-2.0、TypeScript-native、self-hostable、Waitpoint Tokens、
// HTTP completion)とTemporal(Signals + wait_condition、Activity
// retries、強いdurability/crash recovery)が、TACTのcanonical state
// (Work/Task/Run/Policy/Approval/Audit)を壊さずに載せられる唯一の
// 2候補として選定済み(n8n/LangGraph/Camundaはworkflow-graph/BPMNが
// canonical modelを所有しすぎる、またはlicensing不整合のため不採用)。
// 最終方針はHYBRID staged: 近い将来はTrigger.dev、Enterprise領域は
// Temporalを候補とする。ただしP5aではどちらのSDKも一切importせず、
// 型契約だけを確定する。
//
// 絶対条件(最重要、P5a Canonical invariants 1-21を全てこのfileの
// 設計で守る):
//   - TACT owns Work / Task / Run / Approval / Clarification / Policy
//     / Audit。Runtimeはこれらのいずれのcanonical business stateも
//     所有しない(invariant 5-7)。
//   - RuntimeはAuthorization Layerではない(invariant 1)。Policy
//     decision(invariant 2)・Approval decision(invariant 3)・
//     Clarification decision(invariant 4)のいずれのownerでもない。
//     RuntimeExecutionRequestという型自体が、承認要否・Policy
//     decisionを運ぶfieldを一切持たない——「既に承認済みの実行」
//     (already_authorized_execution)だけを表現できる、という構造
//     そのものがこの境界を強制する(Step15)。
//   - Run = one execution attempt、Retry = new Run(invariant 8/9)。
//     Runtime-level retry(Runtime infrastructureが内部で行う再送)
//     とTACTのRun retry(新しいRun行を作る、人間/システムの判断)を
//     混同しない(invariant 10、Step17)。
//   - Runtime execution IDはexternal reference(invariant 11)であり、
//     既存のRun.externalRef(core/tact-work/types.ts、Phase C1で
//     "Provider固有ID"用途として既に汎用化済みのRecord<string,
//     unknown>)をそのまま再利用する(invariant 12、Step8)。新しい
//     DB columnは追加しない。
//   - Runtimeが返したstatusだけでTACT stateを勝手に更新しない
//     (invariant 13)。External side effect authorizationは、
//     Runtimeへ渡す前にTACT側(Policy再評価・Approval Integrity
//     検証)で完了していなければならない(invariant 14)。
//   - Approval待ち・Clarification待ちを、Runtimeの独自Waitpoint/
//     Signalとして実装しない(invariant 15/16、Step16)。
//     resolution ≠ resume(既存のTACT設計、docs/architecture/
//     p2-p5-final-architecture.md Section9/14)は変更しない。
//   - AuditはTACT-owned(invariant 17)。このfile・core/tact-runtime/
//     配下のいずれも、core/tact-work/audit.tsを一切importしない
//     (import一覧が構造的に保証する、Step19)。Runtime Adapter自身が
//     tact_audit_eventsへ直接書くことは無い——将来runtime.*
//     Audit eventが必要になった場合も、TACT側の呼び出し元が
//     emitAuditSafely()を呼ぶ(P5b以降のscope、AuditEventCategory/
//     Typeへの"runtime"追加はP4a Step3/4が明示的に見送った通り、
//     このPhaseでも変更しない)。
//   - Provider Gateway(core/tact-integration/)はTACT-owned
//     (invariant 18)。このfileはcore/tact-integration/を一切
//     importしない(構造的に保証、provider-neutralな抽象を
//     Integration固有型に依存させない)。
//   - Runtime Adapterはprovider-neutral(invariant 19)。Trigger.dev
//     固有型・Temporal固有型のいずれもこのfileへ持ち込まない
//     (invariant 20/21)——RuntimeProviderは識別子(stable string
//     union)にとどめ、Trigger.dev SDK/Temporal SDKの型を一切
//     importしない(import一覧ゼロが構造的な証拠)。
//
// スコープ(Step28): 今回変更するのは
// core/tact-runtime/{types.ts,index.ts}のみ。core/tact-integration/
// execution.ts・core/tact-work/execution.ts・core/tact-orchestrator/
// task.tsはP5aでは一切変更しない(live wiringはP5b以降)——現在の
// Slack live executionはcore/tact-integration/execution.tsを直接
// 経由する既存動作のまま変わらない(Step20)。このモジュールはP5a
// 時点でどこからもimportされない(unused foundationのまま、意図的)。

// =========================
// RuntimeProvider (Step4)
// =========================
//
// Provider-neutralな安定識別子。Execution Runtime Comparative Review
// が確定した2つの将来候補(trigger_dev/temporal)をあらかじめ名前だけ
// 登録する——ただしこれは識別子のenumにすぎず、いずれのSDKへの
// 依存もこの型からは一切生まれない(型を先取りしても実装義務は
// 生まれない)。"native"はP5a時点で唯一の実装(tests/tact/runtime/配下
// のFakeRuntimeAdapter)が名乗る、外部durable executionを持たない
// baseline provider identityであり、TACT自身をRuntimeとして実装した
// ものではない(Composio Providerの"composio"と同じ「識別子」という
// 役割にとどまる)。
//
// 重要(Step4): provider name ≠ runtime execution ID。RuntimeProvider
// は「どのRuntime基盤か」を表すだけであり、個々のexecution attemptを
// 一意に指すのはRuntimeExecutionHandle.executionId(下記)の責務。
export type RuntimeProvider = "native" | "trigger_dev" | "temporal";

export const RUNTIME_PROVIDERS: readonly RuntimeProvider[] = [
  "native",
  "trigger_dev",
  "temporal",
];

// =========================
// RuntimeCapabilities (Step11)
// =========================
//
// Trigger.dev/Temporalの機能差を吸収するためのcapability discovery
// foundation。TACTが将来実際に使う可能性がある機能だけを最小限
// 登録する(過剰taxonomy回避、Step11絶対条件)。
//
// 絶対条件: capabilityがfalseの機能を、呼び出し元(TACT Core/
// Orchestrator)が勝手にemulateしない——例えばdurableWait:falseの
// Runtimeに対して、TACT側が独自のpollingループでdurable waitを
// 代替実装する、といった設計はこのPhaseでもP5b以降でも禁止
// (invariant群の「RuntimeはTACTのcanonical state/decision owner
// ではない」という原則の裏返しであり、TACT側もRuntimeの不足機能を
// 肩代わりして独自の実行制御ロジックを増殖させてはならない)。
export interface RuntimeCapabilities {

  // 呼び出しから切断されても実行が継続する(worker crash後も再開
  // 可能)か。Trigger.dev/Temporalは共にtrue、"native"(fake/test用途
  // のみ)はfalse。
  durableExecution: boolean;

  // 外部要因(Approval解決等の将来のwake-up、Step16)を、Runtime
  // infrastructure自身が長時間安全に待機できるか。P5aではこの機能を
  // 一切使わない(waitpoint/signal API自体を実装しない、Step16)。
  durableWait: boolean;

  // 将来の実行(delayed execution)をRuntime側でscheduleできるか。
  // P5aではscheduler/cron/timerのいずれも実装しない(Step28
  // non-goals)。
  scheduling: boolean;

}

// =========================
// RuntimeExecutionRequest (Step5/Step6)
// =========================
//
// Runtimeへ渡すのは「実行可能になった(=Policy/Approval/Approval
// Integrityが既に完了した)仕事のexecution instruction」のみ。
//
// 絶対条件(Step15、Authorization boundary): この型は意図的に
// policy decision・approval要否・Approval Integrity検証結果の
// いずれのfieldも持たない。RuntimeExecutionRequestを構築できる
// 時点で、その実行は既にTACT側で認可済み(already_authorized_
// execution)である、という契約を型の欠落によって強制する
// (「渡せるfieldが無い」ことが「渡せない」ことの構造的証拠)。
//
// 絶対条件(Step6、payload最小化): canonical Work全体・Approval row
// 全体・Audit historyのいずれもここへコピーしない。workId/taskId/
// runIdという「再取得可能なreference」を中心に据える。
//
// 現在の実行単位(Step5)はIntegration Action中心(core/
// tact-integration/types.tsのIntegrationAction)なので、将来
// Capability実行等の別kindを追加できるよう、kindで判別する
// discriminated unionとして最小限定義する。P5a時点ではメンバーは
// "integration_action"の1つのみ(追加は将来のadditive変更で足りる、
// 既存メンバーを壊さない)。
//
// 未解決のまま意図的に残す設計判断(Step6終盤: 「P5aではfetch
// protocolを作らない」): actionのcanonical input(例:
// Slackへ送るtext本文)は、この型に一切含めない。connectionId/
// service/operationという「何を実行するかの識別子」だけを保持し、
// 実際のinput本文をRuntimeへどう届けるか(canonicalInputをinlineで
// 載せるのか、Runtime workerがtrusted TACT Coreへ戻って取得する
// fetchbackプロトコルを新設するのか)は、実際にRuntime Adapterを
// 接続するPhase(P5b以降)で改めて判断する、明示的な未決事項として
// 残す(推測で埋めない)。
export type RuntimeExecutionRequest =
  | {

      kind: "integration_action";

      // Fast Port P5c追記: Trigger.dev task側(core/tact-runtime/
      // execution.tsのexecuteRuntimeIntegrationRead())がservice role
      // credential経由でWork/Connectionを再取得する際に必要な、
      // ownership-scoped queryのuserId。secretではなくcanonical
      // reference(既存のworkId/taskId/runIdと同じ扱い)。
      userId: string;

      // TACT canonical correlation(Step6の「再取得可能なreference」
      // 中心方針)。
      workId: string;

      taskId: string;

      runId: string;

      // 呼び出し元が任意に付与できる、Runtime側log/trace用の相関ID。
      // TACT canonical IDの代わりにはならない(あくまで補助情報)。
      correlationId?: string | null;

      action: {

        // core/tact-integration/types.tsのIntegrationService/
        // IntegrationActionをそのまま再importしない(Step19絶対条件:
        // このモジュールはcore/tact-integration/への依存を持たない、
        // provider-neutralな抽象を保つ)。値としては現状"slack"等が
        // 入るが、型としては自由文字列にとどめる。
        service: string;

        operation: string;

        // Provider側の接続参照そのもの(OAuth token等の生secret)は
        // 含めない——Connection.id(TACT canonical reference)のみ。
        // 絶対条件(Step5): raw Supabase service role key・OAuth
        // secret・unrestricted Work mutation permissionのいずれも
        // この型には存在しない。
        connectionId: string;

      };

    };

// =========================
// RuntimeExecutionHandle (Step7)
// =========================
//
// Runtime start成功時に返る、provider-neutralなopaque handle。
// executionIdの中身(Trigger.dev task run ID、Temporal workflow ID
// 等)をTACTは一切解釈しない——文字列として保持・受け渡しするだけ。
export interface RuntimeExecutionHandle {

  provider: RuntimeProvider;

  executionId: string;

}

// =========================
// RuntimeError / RuntimeStartOutcome (Step9/Step10)
// =========================
//
// 既存core/tact-integration/types.tsのIntegrationErrorCode/
// IntegrationExecutionError/IntegrationExecutionResultと同じ設計
// 語彙(discriminated union、Provider生errorをcanonical codeへ
// 正規化してから返す)をそのまま踏襲する(新しいerror表現方式を
// 増やさない)。
//
// taxonomyは最小限にとどめる(Step10絶対条件、過剰登録禁止)。
export type RuntimeErrorCode =
  | "runtime_unavailable"
  | "runtime_rejected"
  | "invalid_request"
  | "unknown_runtime_error";

export interface RuntimeError {

  code: RuntimeErrorCode;

  // Provider固有のraw error文字列をそのまま入れない(safe/正規化
  // 済みの診断用文言のみ)。
  message: string;

  // 絶対条件(最重要、Step17): この値はRuntime infrastructureの
  // 再送可能性を示すだけであり、TACTが新しいRunを作る判断
  // (Retry = new Run)とは完全に独立している。retryable===trueで
  // あっても、このAdapter契約自身が自動的にTACT側へ新しいRunを
  // 作らせることは無い(P5a時点でこのfileはcore/tact-work/store.ts
  // のcreateRun()を一切importしない、構造的に保証)。
  //
  // Runtime infrastructure retry(例: Trigger.devのtask attempt retry、
  // Temporal Activity retry)は将来、safe/idempotentなinfrastructure
  // stepに対してのみ許容されうる——しかしTACTが既に認可した
  // side effect(Slack投稿等)を無断で複製してはならない
  // (contract: "Runtime infrastructure may retry safe infrastructure
  // steps, but must not silently duplicate TACT-authorized side
  // effects.")。この重複排除(idempotency/dedup)の実装自体はP5aの
  // scope外——将来Trigger.dev/Temporal Adapterを実装するPhaseで
  // 改めて設計する。
  retryable: boolean;

}

// 絶対条件(Step9): throw-onlyにしない。started/failedのdiscriminated
// unionとして正規化する。
export type RuntimeStartOutcome =
  | {
      status: "started";
      handle: RuntimeExecutionHandle;
    }
  | {
      status: "failed";
      error: RuntimeError;
    };

// =========================
// RuntimeAdapter (Step3)
// =========================
//
// P5aではstartExecution()のみ定義する。cancel/pause/resume/signal/
// schedule/queryStatusは、実producerが存在しないため今回追加しない
// (Step3絶対条件: DEFER)。ただしこの最小contract自体は、将来
// Trigger.dev(HTTP trigger + Waitpoint Token)・Temporal
// (StartWorkflowExecution + Signal)のいずれの実装でも満たせる
// 形であることを設計時に確認済み(両者とも「start」に相当する
// 単一の起動APIを持つ)。
export interface RuntimeAdapter {

  readonly provider: RuntimeProvider;

  getCapabilities(): RuntimeCapabilities;

  startExecution(request: RuntimeExecutionRequest): Promise<RuntimeStartOutcome>;

}

// =========================
// Run.externalRef mapping (Step8)
// =========================
//
// 既存Run.externalRef(core/tact-work/types.ts)は既に
// `Record<string, unknown> | null`という自由formのJSON objectであり
// (Phase C1時点で"Provider固有ID"用途として汎用化済み、
// core/tact-integration/execution.tsが既に{approvalId,
// providerExecutionRef}という複数keyを同じobjectへ同居させている
// 実例が存在する)、新しいDB columnはもちろん、新しいstring
// serialization schemeも不要である。RuntimeExecutionHandleは、この
// 既存objectへ2つの well-known keyとして同居させるだけでよい。
//
// 絶対条件(Step8最重要): この2 fieldはあくまで「external execution
// reference」であり、TACTがRunを識別するcanonical ID
// (Run.id、Supabase発行のUUID)を置き換えるものではない
// (invariant 11/12)。
export interface RuntimeExternalRefFields {

  runtimeProvider: RuntimeProvider;

  runtimeExecutionId: string;

}

// RuntimeExecutionHandleを、既存Run.externalRef object(Record<string,
// unknown>)へmergeするためのfragmentへ変換する。呼び出し元
// (将来のP5b配線)は`{ ...existingExternalRef, ...toRunExternalRefFields(handle) }`
// のように、既存の他key(approvalId等)を壊さずmergeする想定
// (このfile自身はcompleteRun()/failRun()を呼ばない——live wiring
// はP5aのscope外、Step28)。
export function toRunExternalRefFields(handle: RuntimeExecutionHandle): RuntimeExternalRefFields {

  return {
    runtimeProvider: handle.provider,
    runtimeExecutionId: handle.executionId,
  };

}

// 既存Run.externalRefから、RuntimeExecutionHandleを安全に読み戻す
// (round-trip)。malformed(型が違う・欠落している)な場合はnullを
// 返す——fail closedであり、例外を投げない(呼び出し元がAudit/表示
// 目的で気軽に呼べるようにする)。
export function readRuntimeExecutionHandle(
  externalRef: Record<string, unknown> | null | undefined
): RuntimeExecutionHandle | null {

  if (!externalRef) {
    return null;
  }

  const provider = externalRef.runtimeProvider;
  const executionId = externalRef.runtimeExecutionId;

  if (typeof executionId !== "string" || executionId.length === 0) {
    return null;
  }

  if (!RUNTIME_PROVIDERS.includes(provider as RuntimeProvider)) {
    return null;
  }

  return { provider: provider as RuntimeProvider, executionId };

}

// =========================
// 意図的にDEFERした項目(Step13/Step18、報告用)
// =========================
//
// - Runtime registry(resolveRuntimeAdapter(provider)相当): P5a時点で
//   RuntimeAdapterの実装を選択して呼び出す本番producerが存在しない
//   ため、registry自体を追加しない(Step13: 「現在producerが無いなら
//   registry自体DEFERでもよい」)。routing engine/load balancing/
//   fallback/provider scoringは禁止事項として明示されている通り、
//   このPhaseでは一切実装しない。
// - RuntimeExecutionState(実行中statusのquery API): P5aで
//   startExecution()を実際に呼ぶ本番producerが存在しないため、
//   status query APIも追加しない(Step18: 「producerが無いなら
//   status query APIはDEFER推奨」)。将来必要になった時点で、TACT
//   Run.status(running/completed/failed)とは明確に別名の型として
//   追加する(このfileのRuntimeStatus相当を先取りで定義しない)。
