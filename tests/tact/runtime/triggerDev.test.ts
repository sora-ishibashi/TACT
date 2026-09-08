// =========================
// TACT Runtime — Trigger.dev Adapter Regression
// (Fast Port P5b: Trigger.dev Runtime Adapter Implementation)
// =========================
//
// 対象: core/tact-runtime/providers/triggerDev.tsの
// TriggerDevRuntimeAdapter/normalizeTriggerDevError()/
// validateTriggerDevEnv()/resolveTriggerDevConfigFromEnv()。
//
// 実Trigger.dev network call = 0(Step22絶対条件)。全testで
// TriggerDevRuntimeAdapterDeps.triggerFnへfakeを注入し、実SDKの
// tasks.trigger()/configure()には一切到達しない——ただしerror
// normalizationの正確性を検証するため、@trigger.dev/sdkが実際に
// exportする例外class(ApiError.generate()経由、SDK自身が本番で
// 使うのと同じfactory)は使う(installed package typesをそのまま
// source of truthとして使う、Step2)。ApiError.generate()自体は
// 純粋にobjectを組み立てるだけの同期処理であり、一切のnetwork I/O
// を行わない。
import { ApiError } from "@trigger.dev/sdk";
import {
  TriggerDevRuntimeAdapter,
  normalizeTriggerDevError,
  validateTriggerDevEnv,
  resolveTriggerDevConfigFromEnv,
  DEFAULT_TRIGGER_DEV_TASK_IDS,
  type TriggerDevRuntimeConfig,
  type TriggerDevJobPayload,
} from "../../../core/tact-runtime/providers/triggerDev";
import type { RuntimeExecutionRequest } from "../../../core/tact-runtime";
import { check, summarize, type CheckResult } from "../lib/check";

const TEST_CONFIG: TriggerDevRuntimeConfig = {
  secretKey: "tr_dev_test_secret_should_never_leak",
  taskIds: { integrationAction: "tact-integration-action" },
};

function makeRequest(overrides: Partial<Extract<RuntimeExecutionRequest, { kind: "integration_action" }>> = {}): RuntimeExecutionRequest {
  return {
    kind: "integration_action",
    workId: "work-1",
    taskId: "task-1",
    runId: "run-1",
    correlationId: "corr-1",
    action: { service: "slack", operation: "send_message", connectionId: "conn-1" },
    ...overrides,
  };
}

function makeSuccessAdapter(capturedPayloads: TriggerDevJobPayload[], capturedTaskIds: string[]): TriggerDevRuntimeAdapter {
  return new TriggerDevRuntimeAdapter(TEST_CONFIG, {
    triggerFn: async (taskId, payload) => {
      capturedTaskIds.push(taskId);
      capturedPayloads.push(payload);
      return { id: "run_fake_abc123" };
    },
  });
}

function makeFailingAdapter(error: unknown): TriggerDevRuntimeAdapter {
  return new TriggerDevRuntimeAdapter(TEST_CONFIG, {
    triggerFn: async () => {
      throw error;
    },
  });
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Step18 — Success tests
  // =========================

  // ---- [1] provider === trigger_dev ----
  {
    const adapter = makeSuccessAdapter([], []);
    results.push(check("[1] TriggerDevRuntimeAdapter.provider === 'trigger_dev'", adapter.provider === "trigger_dev"));
  }

  // ---- [2] capabilities exact ----
  {
    const adapter = makeSuccessAdapter([], []);
    const capabilities = adapter.getCapabilities();
    results.push(
      check(
        "[2] getCapabilities()はTrigger.dev公式docsで確認済みの{durableExecution:true, durableWait:true, scheduling:true}を返す",
        capabilities.durableExecution === true && capabilities.durableWait === true && capabilities.scheduling === true
      )
    );
  }

  // ---- [3]〜[12] integration_action request accepted、正しいtask選択、最小payload、correlation/action fieldsが保持される ----
  {
    const payloads: TriggerDevJobPayload[] = [];
    const taskIds: string[] = [];
    const adapter = makeSuccessAdapter(payloads, taskIds);

    const outcome = await adapter.startExecution(makeRequest());

    results.push(check("[3] integration_action requestはacceptされ、startedを返す", outcome.status === "started"));

    results.push(
      check(
        "[4] config.taskIds.integrationActionで指定したTrigger task IDが選択される(provider-specific task identifierはconfig経由でのみ解決される)",
        taskIds.length === 1 && taskIds[0] === TEST_CONFIG.taskIds.integrationAction
      )
    );

    const payload = payloads[0];

    results.push(
      check(
        "[5] payloadはversioned最小shape(schemaVersion:1, kind)を持つ",
        payload.schemaVersion === 1 && payload.kind === "integration_action"
      )
    );

    results.push(check("[6] workIdが保持される", payload.workId === "work-1"));
    results.push(check("[7] taskIdが保持される", payload.taskId === "task-1"));
    results.push(check("[8] runIdが保持される", payload.runId === "run-1"));
    results.push(check("[9] correlationIdが保持される", payload.correlationId === "corr-1"));
    results.push(check("[10] action.serviceが保持される", payload.action.service === "slack"));
    results.push(check("[11] action.operationが保持される", payload.action.operation === "send_message"));
    results.push(check("[12] action.connectionIdが保持される(TACT canonical Connection referenceそのまま、secretではない)", payload.action.connectionId === "conn-1"));
  }

  // ---- [13][14][15] success returns started、external run IDがexecutionIdになる、raw responseが漏れない ----
  {
    const adapter = makeSuccessAdapter([], []);
    const outcome = await adapter.startExecution(makeRequest());

    results.push(check("[13] successはstatus:'started'を返す", outcome.status === "started"));

    results.push(
      check(
        "[14] triggerFnが返したid('run_fake_abc123')がRuntimeExecutionHandle.executionIdへそのまま正規化される",
        outcome.status === "started" && outcome.handle.provider === "trigger_dev" && outcome.handle.executionId === "run_fake_abc123"
      )
    );

    results.push(
      check(
        "[15] RuntimeExecutionHandleはprovider/executionIdの2 fieldのみを持ち、Trigger.dev固有のraw response(publicAccessToken/taskIdentifier等)を一切公開しない",
        outcome.status === "started" &&
          Object.keys(outcome.handle).sort().join(",") === "executionId,provider"
      )
    );
  }

  // =========================
  // Step19 — Secret tests
  // =========================

  // ---- [16]〜[20] payloadにsecret類が一切含まれない ----
  {
    const payloads: TriggerDevJobPayload[] = [];
    const adapter = makeSuccessAdapter(payloads, []);

    await adapter.startExecution(makeRequest());

    const serialized = JSON.stringify(payloads[0]).toLowerCase();

    results.push(check("[16] payloadにTrigger secret(TEST_CONFIG.secretKey)が含まれない", !serialized.includes("tr_dev_test_secret_should_never_leak")));
    results.push(check("[17] payloadにComposio API keyらしき文字列が含まれない", !serialized.includes("composio") && !serialized.includes("apikey") && !serialized.includes("api_key")));
    results.push(check("[18] payloadにOAuth tokenらしきfieldが含まれない", !serialized.includes("oauth") && !serialized.includes("token")));
    results.push(check("[19] payloadにSupabase service role keyらしきfieldが含まれない", !serialized.includes("service_role") && !serialized.includes("supabase")));
    results.push(check("[20] payloadにAuthorization headerらしきfieldが含まれない", !serialized.includes("authorization") && !serialized.includes("bearer")));
  }

  // ---- [21] config secretが正規化されたRuntimeErrorへ現れない ----
  {
    const error = ApiError.generate(401, { error: { message: "invalid API key" } }, "Unauthorized", undefined);
    const normalized = normalizeTriggerDevError(error);

    results.push(
      check(
        "[21] normalizeTriggerDevError()の戻り値(code/message/retryable)にconfig secret(TEST_CONFIG.secretKey)が一切含まれない",
        !JSON.stringify(normalized).includes("tr_dev_test_secret_should_never_leak")
      )
    );
  }

  // ---- [22] adapterがsecretをログ出力しない ----
  {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const loggedArgs: unknown[] = [];
    console.log = (...args: unknown[]) => { loggedArgs.push(args); };
    console.warn = (...args: unknown[]) => { loggedArgs.push(args); };
    console.error = (...args: unknown[]) => { loggedArgs.push(args); };

    try {

      const adapter = makeSuccessAdapter([], []);
      await adapter.startExecution(makeRequest());

      const failingAdapter = makeFailingAdapter(new Error("boom"));
      await failingAdapter.startExecution(makeRequest());

    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    const serializedLogs = JSON.stringify(loggedArgs);

    results.push(
      check(
        "[22] startExecution()の成功/失敗いずれの経路でも、console.log/warn/errorが一切呼ばれない(secretをログ出力しない、TriggerDevRuntimeAdapter自身はconsole APIを一切importしていない構造的証拠と一致)",
        loggedArgs.length === 0 && !serializedLogs.includes("tr_dev_test_secret_should_never_leak")
      )
    );
  }

  // =========================
  // Step20 — Failure normalization tests
  // =========================

  // ---- [23] invalid request → invalid_request ----
  {
    const adapter = makeSuccessAdapter([], []);
    const outcome = await adapter.startExecution(makeRequest({ workId: "" }));

    results.push(
      check(
        "[23] 必須fieldが欠落したrequest(workId空文字)はinvalid_requestを返す(triggerFnは呼ばれない)",
        outcome.status === "failed" && outcome.error.code === "invalid_request"
      )
    );
  }

  // ---- [24] runtime service unavailable → runtime_unavailable(InternalServerError/ApiConnectionError双方) ----
  {
    const serverErrorAdapter = makeFailingAdapter(ApiError.generate(500, {}, "Internal Server Error", undefined));
    const serverErrorOutcome = await serverErrorAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[24a] 5xx(InternalServerError)はruntime_unavailableへ正規化される",
        serverErrorOutcome.status === "failed" && serverErrorOutcome.error.code === "runtime_unavailable"
      )
    );

    // status===undefinedはApiConnectionError相当(ネットワーク到達不能)。
    const networkErrorAdapter = makeFailingAdapter(ApiError.generate(undefined, undefined, undefined, undefined));
    const networkErrorOutcome = await networkErrorAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[24b] ネットワーク到達不能(status===undefined、ApiConnectionError相当)もruntime_unavailableへ正規化される",
        networkErrorOutcome.status === "failed" && networkErrorOutcome.error.code === "runtime_unavailable"
      )
    );

    const authErrorAdapter = makeFailingAdapter(ApiError.generate(401, {}, "Unauthorized", undefined));
    const authErrorOutcome = await authErrorAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[24c] 認証エラー(401 AuthenticationError)もruntime_unavailableへ正規化される(brief Step12: authentication/config → runtime_unavailable)",
        authErrorOutcome.status === "failed" && authErrorOutcome.error.code === "runtime_unavailable"
      )
    );
  }

  // ---- [25] runtime rejection → runtime_rejected ----
  {
    const conflictAdapter = makeFailingAdapter(ApiError.generate(409, {}, "Conflict", undefined));
    const conflictOutcome = await conflictAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[25] Trigger APIのjob拒否(409 ConflictError)はruntime_rejectedへ正規化される",
        conflictOutcome.status === "failed" && conflictOutcome.error.code === "runtime_rejected"
      )
    );
  }

  // ---- [26] unknown exception → unknown_runtime_error ----
  {
    const unknownAdapter = makeFailingAdapter(new TypeError("unexpected programming error"));
    const outcome = await unknownAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[26] ApiErrorではない一般的な例外(TypeError)はunknown_runtime_errorへ正規化される",
        outcome.status === "failed" && outcome.error.code === "unknown_runtime_error"
      )
    );

    const unmappedStatusAdapter = makeFailingAdapter(ApiError.generate(418, {}, "I'm a teapot", undefined));
    const unmappedOutcome = await unmappedStatusAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[26b] mapping表に無いstatus(418、ApiErrorだがsubclass無し)もunknown_runtime_errorへ安全にfallbackする",
        unmappedOutcome.status === "failed" && unmappedOutcome.error.code === "unknown_runtime_error"
      )
    );
  }

  // ---- [27] retryable mapping ----
  {
    const rateLimit = normalizeTriggerDevError(ApiError.generate(429, {}, "Too Many Requests", undefined));
    const conflict = normalizeTriggerDevError(ApiError.generate(409, {}, "Conflict", undefined));
    const serverError = normalizeTriggerDevError(ApiError.generate(500, {}, "Internal Server Error", undefined));
    const badRequest = normalizeTriggerDevError(ApiError.generate(400, {}, "Bad Request", undefined));
    const auth = normalizeTriggerDevError(ApiError.generate(401, {}, "Unauthorized", undefined));

    results.push(
      check(
        "[27] retryable mapping: RateLimitError(429)=true / ConflictError(409)=false / InternalServerError(5xx)=true / BadRequestError(400)=false / AuthenticationError(401)=false",
        rateLimit.retryable === true &&
          conflict.retryable === false &&
          serverError.retryable === true &&
          badRequest.retryable === false &&
          auth.retryable === false
      )
    );
  }

  // ---- [28] raw stack/body not leaked ----
  {
    const rawBody = { secret_internal_field: "should-not-leak", stack: "at someInternalFunction (/app/secret/path.ts:42)" };
    const error = ApiError.generate(400, { error: rawBody }, "Bad Request", undefined);
    const normalized = normalizeTriggerDevError(error);

    results.push(
      check(
        "[28] normalizeTriggerDevError()の戻り値にraw response body(secret_internal_field等)やstack trace文字列が含まれない(safe固定文言のみ)",
        !JSON.stringify(normalized).includes("secret_internal_field") &&
          !JSON.stringify(normalized).includes("someInternalFunction")
      )
    );
  }

  // ---- [29] failure outcome does not throw ----
  {
    const adapter = makeFailingAdapter(new Error("should be caught, not thrown"));

    let threw = false;

    try {
      await adapter.startExecution(makeRequest());
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[29] triggerFnが例外を投げても、startExecution()自身は例外を外へ伝播させず、正規化されたfailed outcomeを返す(throw-onlyにしない、P5a契約通り)",
        threw === false
      )
    );
  }

  // =========================
  // Step21 — Ownership boundary tests(structural)
  // =========================
  {
    const adapter = makeSuccessAdapter([], []);

    results.push(
      check(
        "[30] TriggerDevRuntimeAdapterはcreateRun相当のAPIを公開しない(core/tact-work/store.tsを一切importしていない構造的証拠)",
        typeof (adapter as unknown as { createRun?: unknown }).createRun === "undefined"
      )
    );

    results.push(
      check(
        "[31][32] TriggerDevRuntimeAdapterはWork/Task mutation API(updateWorkStatus/updateTaskStatus等)を一切公開しない",
        typeof (adapter as unknown as { updateWorkStatus?: unknown }).updateWorkStatus === "undefined" &&
          typeof (adapter as unknown as { updateTaskStatus?: unknown }).updateTaskStatus === "undefined"
      )
    );

    results.push(
      check(
        "[33] TriggerDevRuntimeAdapterはApproval決定API(approveApproval/rejectApproval等)を一切公開しない",
        typeof (adapter as unknown as { approveApproval?: unknown }).approveApproval === "undefined" &&
          typeof (adapter as unknown as { rejectApproval?: unknown }).rejectApproval === "undefined"
      )
    );

    results.push(
      check(
        "[34] TriggerDevRuntimeAdapterはClarification解決API(resolveClarification等)を一切公開しない",
        typeof (adapter as unknown as { resolveClarification?: unknown }).resolveClarification === "undefined"
      )
    );

    results.push(
      check(
        "[35] TriggerDevRuntimeAdapterはAudit書き込みAPI(recordAuditEvent/emitAuditEvent等)を一切公開しない(core/tact-work/audit.tsを一切importしていない構造的証拠)",
        typeof (adapter as unknown as { recordAuditEvent?: unknown }).recordAuditEvent === "undefined" &&
          typeof (adapter as unknown as { emitAuditEvent?: unknown }).emitAuditEvent === "undefined"
      )
    );

    results.push(
      check(
        "[36] TriggerDevRuntimeAdapterはComposio/Provider実行API(executeIntegrationAction等)を一切公開しない(core/tact-integration/を一切importしていない構造的証拠)",
        typeof (adapter as unknown as { executeIntegrationAction?: unknown }).executeIntegrationAction === "undefined"
      )
    );

    results.push(
      check(
        "[37] TriggerDevRuntimeAdapterはPolicy評価API(evaluatePolicyDecision等)を一切公開しない(core/tact-integration/policy.tsを一切importしていない構造的証拠)",
        typeof (adapter as unknown as { evaluatePolicyDecision?: unknown }).evaluatePolicyDecision === "undefined"
      )
    );
  }

  // =========================
  // 追加: config boundary(Step9) — validateTriggerDevEnv() /
  // resolveTriggerDevConfigFromEnv()のunit test(実process.envは
  // 一切変更しない、injected envオブジェクトのみを使う)
  // =========================
  {
    const missingEnv = validateTriggerDevEnv({});

    results.push(
      check(
        "[config] TRIGGER_SECRET_KEY未設定の場合、validateTriggerDevEnv()はok:false・missingに'TRIGGER_SECRET_KEY'を含む",
        missingEnv.ok === false && missingEnv.missing.includes("TRIGGER_SECRET_KEY")
      )
    );

    const presentEnv = validateTriggerDevEnv({ TRIGGER_SECRET_KEY: "tr_dev_x" });

    results.push(check("[config] TRIGGER_SECRET_KEY設定済みの場合、ok:trueを返す", presentEnv.ok === true));

    results.push(
      check(
        "[config] resolveTriggerDevConfigFromEnv(): 未設定envはnullを返す(例外を投げない、fail closed)",
        resolveTriggerDevConfigFromEnv({}) === null
      )
    );

    const resolved = resolveTriggerDevConfigFromEnv({
      TRIGGER_SECRET_KEY: "tr_dev_x",
      TRIGGER_API_URL: "https://self-hosted.example.com",
    });

    results.push(
      check(
        "[config] resolveTriggerDevConfigFromEnv(): TRIGGER_SECRET_KEY/TRIGGER_API_URLが正しく反映され、task IDは未設定時DEFAULT_TRIGGER_DEV_TASK_IDSへfallbackする",
        resolved?.secretKey === "tr_dev_x" &&
          resolved?.baseURL === "https://self-hosted.example.com" &&
          resolved?.taskIds.integrationAction === DEFAULT_TRIGGER_DEV_TASK_IDS.integrationAction
      )
    );
  }

  return summarize("runtime/triggerDev", results);

}
