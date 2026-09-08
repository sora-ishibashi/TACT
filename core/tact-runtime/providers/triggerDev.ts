// =========================
// TACT Runtime — Trigger.dev Provider Adapter
// (Fast Port P5b: Trigger.dev Runtime Adapter Implementation)
// =========================
//
// core/tact-runtime/配下で@trigger.dev/sdkをimportするのはこのfileだけ
// (core/tact-integration/providers/composio/配下だけが@composio/core
// をimportするのと同じ既存precedentを踏襲する)。このfileは
// core/tact-runtime/index.ts(provider-neutral public barrel)からは
// 再exportしない——将来この provider を使う呼び出し元は、この path を
// 直接importする(絶対条件、invariant13/20: Trigger.dev固有型を
// core/tact-runtime public contractへ漏らさない)。
//
// P5a契約(../types.ts)は変更しない。このfileはRuntimeAdapterを
// implementsするだけで、public contract自体には一切手を加えない。
//
// 公式API検証(Step2、推測実装禁止): 2026-09-09時点で以下を一次情報
// から直接確認済み(installed package type declarations = source of
// truth、`node_modules/@trigger.dev/sdk/dist/commonjs/v3/{tasks,
// shared,auth}.d.ts`・`node_modules/@trigger.dev/core/dist/commonjs/
// v3/apiClient/errors.d.ts`。および https://trigger.dev/docs/triggering
// 、https://trigger.dev/docs/management/errors-and-retries):
//   - `tasks.trigger<TTask extends AnyTask>(id: TaskIdentifier<TTask>,
//     payload: TaskPayload<TTask>, options?, requestOptions?):
//     Promise<RunHandle<...>>`。task定義ファイルをimportせず
//     `tasks.trigger<AnyTask>(taskIdString, payload)`という形で
//     呼び出せる(`AnyTask = Task<string, any, any>`であり、
//     `TaskIdentifier<AnyTask>`はstringへ解決される)ことを、実際に
//     installed typesに対して`tsc --noEmit`でコンパイル確認済み。
//   - 返り値`RunHandle`の実体shapeは`{id: string, publicAccessToken:
//     string, taskIdentifier: string}`(+型レベルのbrand)。
//   - `configure(options: {baseURL?, accessToken?})`はSDK全体の
//     global設定(内部AsyncLocalStorage、`@trigger.dev/core/v3/
//     sdk-scope-storage`)。呼ばなくても`TRIGGER_SECRET_KEY`/
//     `TRIGGER_API_URL`環境変数から自動解決される(auth.d.tsの
//     JSDocに明記)。
//   - Errorはthrow-based(discriminated returnではない)。
//     `@trigger.dev/sdk`が公開する例外クラス階層(すべて`ApiError`
//     のsubclass、`errors.d.ts`で確認): `BadRequestError`(400)・
//     `AuthenticationError`(401)・`PermissionDeniedError`(403)・
//     `NotFoundError`(404)・`ConflictError`(409)・
//     `UnprocessableEntityError`(422)・`RateLimitError`(429)・
//     `InternalServerError`(5xx)・`ApiConnectionError`(status:
//     undefined、ネットワーク到達不能。このclass自体は`@trigger.dev/
//     sdk`のpublic barrelからexportされていないため、`ApiError`
//     かつ`status===undefined`という構造的条件で代わりに判定する)。
import {
  tasks,
  runs,
  configure,
  ApiError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  RateLimitError,
  InternalServerError,
  type AnyTask,
} from "@trigger.dev/sdk";
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeExecutionRequest,
  RuntimeStartOutcome,
  RuntimeError,
  RuntimeExecutionHandle,
  RuntimeExecutionLookupOutcome,
  RuntimeExecutionState,
} from "../types";

// =========================
// Config boundary (Step9)
// =========================
//
// 絶対条件: core内で`process.env`を散らして読まない。この型を
// 受け取るconstructorが唯一のconfig注入点であり、`process.env`を
// 実際に読むのは下記`resolveTriggerDevConfigFromEnv()`という
// 単一のoptional helperだけ(呼び出すかどうかは呼び出し元の自由、
// このfile自身はどこからも自動的に呼ばない)。
export interface TriggerDevRuntimeConfig {

  // Trigger.dev公式JSDoc(auth.d.ts)の`accessToken`に相当。TACT側の
  // 命名は既存のRuntimeExecutionRequest/RuntimeErrorの語彙に合わせて
  // `secretKey`とする(Trigger.dev公式の環境変数名`TRIGGER_SECRET_KEY`
  // とは呼び名を分けている——値の意味は同じ)。
  secretKey: string;

  // 省略時はTrigger.dev公式デフォルト(https://api.trigger.dev)を
  // SDK自身が使う(configure()にundefinedを渡した場合の既定動作)。
  // self-hosted Trigger.devを使う場合にのみ指定する。
  baseURL?: string;

  // RuntimeExecutionRequest.kind → Trigger.dev task ID
  // のmappingをこのconfigへ閉じ込める(Step6絶対条件:
  // RuntimeExecutionRequestへtriggerTaskIdを追加しない、
  // provider-specific task identifierをcanonical requestへ漏らさない)。
  taskIds: {
    integrationAction: string;
  };

}

// P5bで実際にTrigger.devプロジェクト側へtask定義を追加していない
// (Step24、下記参照)ため、この値は「将来task定義を追加する時に
// 使う名前」という位置づけの既定値にとどまる。
export const DEFAULT_TRIGGER_DEV_TASK_IDS = {
  integrationAction: "tact-integration-action",
} as const;

// =========================
// Trigger.dev job payload (Step7/Step11)
// =========================
//
// 絶対条件(Step7、P5aの判断を維持): raw integration input
// (例: Slackへ送るtext本文)は一切含めない。P5aのRuntimeExecutionRequest
// が既に「再取得可能なreference中心」に絞ってあるため、この
// payloadはそれをそのままversioned formへ変換するだけ
// (schemaVersion: 1、Step11)。
//
// 絶対条件(Step8/Step17): provider credential
// (TRIGGER_SECRET_KEY・Composio key・OAuth token・Supabase service
// role key・Authorization header等)はこのpayloadに一切含まれない
// ——含まれるのはTACT canonical correlation id(workId/taskId/runId)
// とTACT canonical Connection.id(connectionId、secretではない
// reference。実secretはcore/tact-integration/types.tsの
// providerConnectionRefであり、この型はそれを一切参照しない)のみ。
export interface TriggerDevIntegrationActionPayload {

  schemaVersion: 1;

  kind: "integration_action";

  // Fast Port P5c: Trigger.dev task側(core/tact-runtime/execution.ts)が
  // service role credential経由でownership-scoped queryを行うために
  // 必要(secretではない、既存のworkId等と同じcanonical reference)。
  userId: string;

  workId: string;

  taskId: string;

  runId: string;

  correlationId?: string | null;

  action: {
    service: string;
    operation: string;
    connectionId: string;
  };

}

export type TriggerDevJobPayload = TriggerDevIntegrationActionPayload;

// =========================
// Testability seam (Step10)
// =========================
//
// 絶対条件(Fast Port P4a incidentの教訓を踏襲): testはこのfunctionを
// 差し替えるだけで、実SDK(tasks.trigger()・configure())へは一切
// 到達しない。real network call = 0(Step22)。
// Fast Port P5d(Step3/Step5): dispatch idempotency。official Trigger.dev
// primitive(TriggerOptions.idempotencyKey、installed types確認済み:
// 「同じidempotencyKeyでtrigger()を2回呼ぶと、2回目は新しいrunを
// 作らず1回目のhandleをそのまま返す」)をそのまま使う——自前in-memory
// dedupやSupabase側の新dedup tableは作らない(絶対条件、Step5)。
export interface TriggerDevTriggerOptions {
  idempotencyKey?: string;
  idempotencyKeyTTL?: string;
  tags?: string[];
}

export type TriggerDevTriggerFn = (
  taskId: string,
  payload: TriggerDevJobPayload,
  options?: TriggerDevTriggerOptions
) => Promise<{ id: string }>;

// Fast Port P5d(Step9/Step21): optional test seam。real SDKの
// runs.retrieve()を呼ぶ既定実装は、real network callが必要な場合
// のみ使われる(testは常にfakeを注入する、Step34 test#33相当)。
export type TriggerDevLookupExecutionFn = (
  executionId: string
) => Promise<{ status: string } | null>;

export interface TriggerDevRuntimeAdapterDeps {
  triggerFn?: TriggerDevTriggerFn;
  lookupExecutionFn?: TriggerDevLookupExecutionFn;
}

// =========================
// TriggerDevRuntimeAdapter (Step5)
// =========================
//
// P5a RuntimeAdapter contractをそのままimplementsする——Trigger.dev
// 都合でP5a public contract(../types.ts)を変更しない(Step5絶対条件)。
export class TriggerDevRuntimeAdapter implements RuntimeAdapter {

  readonly provider = "trigger_dev" as const;

  private readonly config: TriggerDevRuntimeConfig;

  private readonly triggerFn: TriggerDevTriggerFn;

  private readonly lookupExecutionFn: TriggerDevLookupExecutionFn;

  constructor(config: TriggerDevRuntimeConfig, deps: TriggerDevRuntimeAdapterDeps = {}) {

    this.config = config;

    if (deps.triggerFn) {

      // test seam: 実SDKへは一切触れない。
      this.triggerFn = deps.triggerFn;

    } else {

      // 設定boundary(Step9): configure()はここで1回だけ呼ぶ
      // (adapter構築時)。secretをconsole等へ出力しない
      // (絶対条件、Step19 test #22)。
      configure({ accessToken: config.secretKey, baseURL: config.baseURL });

      this.triggerFn = async (taskId, payload, options) => {
        const handle = await tasks.trigger<AnyTask>(taskId, payload, {
          idempotencyKey: options?.idempotencyKey,
          idempotencyKeyTTL: options?.idempotencyKeyTTL,
          tags: options?.tags,
        });
        return { id: handle.id };
      };

    }

    if (deps.lookupExecutionFn) {

      this.lookupExecutionFn = deps.lookupExecutionFn;

    } else {

      this.lookupExecutionFn = async (executionId) => {
        const result = await runs.retrieve(executionId);
        return { status: result.status };
      };

    }

  }

  // Fast Port P5d(Step3): 1つのTACT Run(runId)につき1つの安定した
  // dispatch identityを、adapter内部で決定論的に導出する。
  // RuntimeExecutionRequestへprovider-specificなidempotency conceptを
  // 漏らさない(Step4絶対条件: canonical契約を汚しすぎない、
  // runIdという既存fieldだけから導出できるため新fieldは追加不要)。
  // Retry = new Run(絶対条件)なので、new Run ⇒ new runId ⇒ new key。
  private buildDispatchKey(runId: string): string {
    return `tact-run:${runId}`;
  }

  // =========================
  // getCapabilities (Step15)
  // =========================
  //
  // 「使う予定だからtrue」ではなく、実際にTrigger.devがofficial docs
  // 上サポートしているかで決定する(Step15絶対条件)。
  //   - durableExecution: true — durable executionそのものが
  //     Trigger.devの中核機能(公式docs全体で一貫して説明されている)。
  //   - durableWait: true — Waitpoint Tokens(公式docs
  //     `https://trigger.dev/docs/wait`系、および
  //     docs/prior-art/execution-runtime-comparative-review.md Section
  //     "Wait/resume"で[SOURCE_CONFIRMED]済み: "Waitpoint tokens pause
  //     task runs until you complete the token")。
  //   - scheduling: true — 公式`schedules`(cron)機能
  //     ([DOCUMENTED]、同reviewのSection "Scheduling"参照)。
  // ただしP5bはこれらのいずれも実際には使わない(startExecution()は
  // durableWait/schedulingのAPIを一切呼ばない、Step15/Step20)。
  getCapabilities(): RuntimeCapabilities {

    return {
      durableExecution: true,
      durableWait: true,
      scheduling: true,
    };

  }

  // =========================
  // startExecution (Step10)
  // =========================
  async startExecution(request: RuntimeExecutionRequest): Promise<RuntimeStartOutcome> {

    if (request.kind !== "integration_action") {

      // P5a RuntimeExecutionRequestは現状integration_actionの1
      // memberしか持たないため、型レベルでは到達しない分岐だが、
      // 将来のadditive変更(新kind追加)に対してfail closedする
      // (exhaustiveness、既存core/tact-work/execution.tsと同じ
      // パターン)。
      const exhaustiveCheck: never = request.kind;
      void exhaustiveCheck;

      return {
        status: "failed",
        // ローカルvalidation失敗(この時点でTrigger.devへは一切送信
        // していない)——outcomeKnown: trueで確定(絶対条件Step7)。
        error: {
          code: "invalid_request",
          message: "Unsupported RuntimeExecutionRequest.kind for TriggerDevRuntimeAdapter.",
          retryable: false,
          outcomeKnown: true,
        },
      };

    }

    // 最小限のrequest kind validation(Step10-1、Step18 test#23):
    // 必須のcorrelation/action fieldが空でないことだけを確認する
    // (深いschema検証はしない、過剰実装回避)。
    if (
      !request.userId ||
      !request.workId ||
      !request.taskId ||
      !request.runId ||
      !request.action.service ||
      !request.action.operation ||
      !request.action.connectionId
    ) {

      return {
        status: "failed",
        // 同上、ローカルvalidation失敗——outcomeKnown: true。
        error: {
          code: "invalid_request",
          message: "RuntimeExecutionRequest is missing a required correlation or action field.",
          retryable: false,
          outcomeKnown: true,
        },
      };

    }

    const taskId = this.config.taskIds.integrationAction;

    const payload: TriggerDevJobPayload = {
      schemaVersion: 1,
      kind: "integration_action",
      userId: request.userId,
      workId: request.workId,
      taskId: request.taskId,
      runId: request.runId,
      correlationId: request.correlationId ?? null,
      action: {
        service: request.action.service,
        operation: request.action.operation,
        connectionId: request.action.connectionId,
      },
    };

    // Fast Port P5d(Step3/Step5): 同じTACT Runに対してstartExecution()
    // が複数回呼ばれても(dispatch側の再送・reconciliationからの
    // 再送含む)、Trigger.dev側で重複task executionを作らせない。
    // official idempotency primitive(TriggerOptions.idempotencyKey)
    // だけを使う——自前in-memory dedupは実装しない(絶対条件)。
    const dispatchKey = this.buildDispatchKey(request.runId);

    try {

      // 絶対条件(Step13): この呼び出し自身はcreateRun()もTask/Work
      // mutationも一切行わない(importしていないことが構造的に
      // 保証する)。startExecution failure時にnew Runを作る・
      // Task/Providerをretryする責務はこのAdapterには無い。
      const result = await this.triggerFn(taskId, payload, {
        idempotencyKey: dispatchKey,
        // 既定30日(official docs確認済み)より短くする理由が無いため
        // 明示指定しない——TACT Run自体がそれより短命な想定
        // (read-only sliceのため)。
        // Step11: 非secretなcorrelation(TACT run idのみ)をtagとして
        // 付与する——Trigger.dev dashboard上でこのexecutionがどの
        // TACT Runに対応するか確認できるようにするだけの補助情報
        // (reconciliationのprimary機構ではない、Step10でOption Aを
        // 採用したためtag検索には依存しない)。
        tags: [dispatchKey],
      });

      return {
        status: "started",
        // Trigger.dev固有のRunHandle object(publicAccessToken等)を
        // そのまま返さない(絶対条件Step10、raw provider response
        // exposure禁止)——executionId(=Trigger.dev run id)だけを
        // provider-neutral shapeへ正規化する。
        handle: { provider: "trigger_dev", executionId: result.id },
      };

    } catch (error) {

      return { status: "failed", error: normalizeTriggerDevError(error) };

    }

  }

  // =========================
  // lookupExecution (Fast Port P5d、Step9/Step21)
  // =========================
  //
  // Read-only observability——Provider再実行やTrigger再startを一切
  // 行わない(絶対条件Step15)。official runs.retrieve()をそのまま
  // 使う(installed types確認済み: statusは"CANCELED"|"COMPLETED"|
  // "CRASHED"|"DELAYED"|"DEQUEUED"|"EXECUTING"|"EXPIRED"|"FAILED"|
  // "PENDING_VERSION"|"QUEUED"|"SYSTEM_FAILURE"|"TIMED_OUT"|
  // "WAITING"の13値)。
  async lookupExecution(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionLookupOutcome> {

    try {

      const result = await this.lookupExecutionFn(handle.executionId);

      if (!result) {
        return { status: "not_found" };
      }

      return { status: "found", state: normalizeTriggerDevExecutionState(result.status) };

    } catch (error) {

      const normalized = normalizeTriggerDevError(error);

      if (normalized.code === "invalid_request" && error instanceof NotFoundError) {
        return { status: "not_found" };
      }

      return { status: "lookup_failed", error: normalized };

    }

  }

}

// Fast Port P5d(Step14絶対条件): Trigger-specific statusをそのまま
// unionへコピーせず、TACT canonical taxonomyへ正規化する。TACT
// Run.statusへの自動mapはしない(呼び出し元の責務)。
function normalizeTriggerDevExecutionState(rawStatus: string): RuntimeExecutionState {

  switch (rawStatus) {

    case "QUEUED":
    case "DELAYED":
    case "PENDING_VERSION":
    case "DEQUEUED":
      return "queued";

    case "EXECUTING":
      return "running";

    case "WAITING":
      return "waiting";

    case "COMPLETED":
      return "completed";

    case "FAILED":
    case "CRASHED":
    case "SYSTEM_FAILURE":
    case "TIMED_OUT":
    case "EXPIRED":
      return "failed";

    case "CANCELED":
      return "cancelled";

    default:
      return "unknown";

  }

}

// =========================
// Error normalization (Step12)
// =========================
//
// mapping方針(brief Step12の指示 + 実際のerror class階層から導出):
//   - RateLimitError(429) → runtime_rejected(retryable: true。
//     rate limitは再送で解消しうるinfrastructure-level制約)。
//   - ConflictError(409) → runtime_rejected(retryable: false。
//     「Trigger APIがjobを拒否した」に該当する業務的衝突)。
//   - BadRequestError(400)/UnprocessableEntityError(422)/
//     NotFoundError(404) → invalid_request(retryable: false。
//     client misuse——不正なpayload・存在しないtask ID等の設定ミス)。
//   - AuthenticationError(401)/PermissionDeniedError(403) →
//     runtime_unavailable(retryable: false。brief Step12の
//     「authentication/config ... → runtime_unavailable」に対応。
//     秘密鍵の設定ミスは再送しても直らないためfalse)。
//   - InternalServerError(5xx) → runtime_unavailable(retryable:
//     true。一時的なservice unavailableとして扱う)。
//   - ApiError(上記いずれにも該当しない、または`status===undefined`
//     でネットワーク到達不能=ApiConnectionError相当) →
//     `status===undefined`ならruntime_unavailable(retryable:
//     true)、それ以外はunknown_runtime_error(retryable: false)。
//   - ApiErrorではない例外(programming error等) →
//     unknown_runtime_error(retryable: false)。
//
// 絶対条件(Step12/Step19 test #21): raw stack trace・response
// body・secret(Authorization header値等)をmessageへ含めない
// ——safe/正規化済みの固定文言のみを返す。
// Fast Port P5d(Step7絶対条件): outcomeKnownの判定方針——Trigger.dev
// サーバが明確なHTTP応答(status付き)を返した場合は、requestが確実に
// 届いた(=side effectの有無が確定している)という意味でtrue。
// ネットワーク到達不能(ApiConnectionError、status===undefined)、
// および分類不能な例外(programming error等、fetch自体が完了した
// 保証がない)はfalse——「届いたかどうか不明」を安全側(ambiguous)へ
// 倒す。
export function normalizeTriggerDevError(error: unknown): RuntimeError {

  if (error instanceof RateLimitError) {
    return {
      code: "runtime_rejected",
      message: "Trigger.dev rejected the request due to rate limiting.",
      retryable: true,
      outcomeKnown: true,
    };
  }

  if (error instanceof ConflictError) {
    return {
      code: "runtime_rejected",
      message: "Trigger.dev rejected the request due to a conflict.",
      retryable: false,
      outcomeKnown: true,
    };
  }

  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError ||
    error instanceof NotFoundError
  ) {
    return {
      code: "invalid_request",
      message: "Trigger.dev rejected the request as invalid (client-side request or configuration problem).",
      retryable: false,
      outcomeKnown: true,
    };
  }

  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return {
      code: "runtime_unavailable",
      message: "Trigger.dev rejected the request due to an authentication or authorization configuration problem.",
      retryable: false,
      outcomeKnown: true,
    };
  }

  if (error instanceof InternalServerError) {
    return {
      code: "runtime_unavailable",
      message: "Trigger.dev reported an internal server error.",
      retryable: true,
      outcomeKnown: true,
    };
  }

  if (error instanceof ApiError) {

    // status===undefinedはApiConnectionError(ネットワーク到達不能)
    // に該当する(errors.d.ts確認済み。このsubclass自体は
    // @trigger.dev/sdkのpublic barrelからexportされていないため、
    // instanceof判定ではなくこの構造的条件で代わりに判定する)。
    if (error.status === undefined) {
      return {
        code: "runtime_unavailable",
        message: "Could not reach the Trigger.dev API.",
        retryable: true,
        // 絶対条件(Step7、最重要): requestが実際にTrigger.devへ
        // 届いたかどうか不明——ambiguous。呼び出し元はこのRunを
        // failedへ確定させず、reconciliationへ委ねる。
        outcomeKnown: false,
      };
    }

    return {
      code: "unknown_runtime_error",
      message: "Trigger.dev returned an unrecognized API error.",
      retryable: false,
      // status付きの応答を受け取っている=requestは確実に届いている。
      outcomeKnown: true,
    };

  }

  return {
    code: "unknown_runtime_error",
    message: "An unrecognized error occurred while starting Trigger.dev execution.",
    retryable: false,
    // 分類不能な例外(ApiErrorではない)——fetch自体が完了した保証が
    // 無いため、安全側でambiguous扱いにする。
    outcomeKnown: false,
  };

}

// =========================
// Optional local/dev config validation (Goal item10)
// =========================
//
// `process.env`を読む唯一の箇所(Step9絶対条件)。P5b時点でどの
// production live pathからも呼ばれない(Step26、unused foundationの
// まま)——将来の起動時config検証・開発時diagnostic用途の
// 純粋関数として提供するだけ。secretの値自体は返り値・ログに
// 一切含めない(missing keyの名前だけを返す)。
export interface TriggerDevEnvValidationResult {
  ok: boolean;
  missing: readonly string[];
}

const TRIGGER_DEV_REQUIRED_ENV_KEYS = ["TRIGGER_SECRET_KEY"] as const;

// NodeJS.ProcessEnv(NODE_ENV必須等)ではなく、testが最小限のfake env
// objectを渡しやすい緩いRecord型を受け取る(process.env自体は
// 構造的にこの型を満たすため、既定値としてそのまま渡せる)。
export type TriggerDevEnvSource = Record<string, string | undefined>;

export function validateTriggerDevEnv(
  env: TriggerDevEnvSource = process.env
): TriggerDevEnvValidationResult {

  const missing = TRIGGER_DEV_REQUIRED_ENV_KEYS.filter((key) => !env[key]);

  return { ok: missing.length === 0, missing };

}

// 環境変数名は公式Trigger.dev convention(auth.d.tsのJSDocで確認済み:
// `TRIGGER_SECRET_KEY`・`TRIGGER_API_URL`)にそのまま合わせる。
// task IDだけはTACT側のenv変数(公式conventionが存在しないため
// 独自命名、未設定時はDEFAULT_TRIGGER_DEV_TASK_IDSへfallbackする)。
export function resolveTriggerDevConfigFromEnv(
  env: TriggerDevEnvSource = process.env
): TriggerDevRuntimeConfig | null {

  const validation = validateTriggerDevEnv(env);

  if (!validation.ok) {
    return null;
  }

  return {
    secretKey: env.TRIGGER_SECRET_KEY as string,
    baseURL: env.TRIGGER_API_URL,
    taskIds: {
      integrationAction:
        env.TRIGGER_TASK_ID_INTEGRATION_ACTION ?? DEFAULT_TRIGGER_DEV_TASK_IDS.integrationAction,
    },
  };

}
