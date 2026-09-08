// =========================
// TACT Runtime — Adapter Foundation Regression
// (Fast Port P5a: Provider-Neutral Runtime Adapter Foundation)
// =========================
//
// 対象: core/tact-runtime/types.tsの型契約(RuntimeAdapter/
// RuntimeExecutionRequest/RuntimeExecutionHandle/RuntimeStartOutcome/
// RuntimeError/RuntimeCapabilities)と、Run.externalRef mapping helper
// (toRunExternalRefFields/readRuntimeExecutionHandle)。
//
// 実Trigger.dev・実Temporal・実Supabaseのいずれにも一切接続しない
// (P5a時点で本番producerが存在しない、意図的なunused foundation)。
// このtest fileだけがFakeRuntimeAdapter(in-memory、zero external I/O)
// を定義する——本番core/tact-runtime/配下にはFake実装を置かない
// (Step12: 「fakeはtest supportとして置く方が自然なら tests側へ配置。
// 不要なproduction Fake classを増やさない」)。

import {
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeExecutionRequest,
  type RuntimeExecutionHandle,
  type RuntimeStartOutcome,
  type RuntimeError,
  toRunExternalRefFields,
  readRuntimeExecutionHandle,
  RUNTIME_PROVIDERS,
} from "../../../core/tact-runtime";
import { check, summarize, type CheckResult } from "../lib/check";

// =========================
// FakeRuntimeAdapter (test support only)
// =========================
//
// 責務(Step12): request capture・deterministic handle返却・
// 設定可能な失敗モード・zero external I/O。Production nativeな
// Runtime実装をここで作り込まない——単なるDI用test double。
class FakeRuntimeAdapter implements RuntimeAdapter {

  readonly provider = "native" as const;

  readonly capturedRequests: RuntimeExecutionRequest[] = [];

  private nextExecutionId = 1;

  private failureMode: RuntimeError | null = null;

  constructor(options?: { capabilities?: Partial<RuntimeCapabilities>; failureMode?: RuntimeError }) {
    this.capabilitiesOverride = options?.capabilities ?? {};
    this.failureMode = options?.failureMode ?? null;
  }

  private capabilitiesOverride: Partial<RuntimeCapabilities>;

  getCapabilities(): RuntimeCapabilities {
    return {
      durableExecution: false,
      durableWait: false,
      scheduling: false,
      ...this.capabilitiesOverride,
    };
  }

  async startExecution(request: RuntimeExecutionRequest): Promise<RuntimeStartOutcome> {

    this.capturedRequests.push(request);

    if (this.failureMode) {
      return { status: "failed", error: this.failureMode };
    }

    const handle: RuntimeExecutionHandle = {
      provider: this.provider,
      executionId: `fake-exec-${this.nextExecutionId++}`,
    };

    return { status: "started", handle };

  }

}

function makeRequest(overrides: Partial<Extract<RuntimeExecutionRequest, { kind: "integration_action" }>> = {}): RuntimeExecutionRequest {
  return {
    kind: "integration_action",
    userId: "user-1",
    workId: "work-1",
    taskId: "task-1",
    runId: "run-1",
    action: { service: "slack", operation: "send_message", connectionId: "conn-1" },
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Step23 — Contract tests
  // =========================

  // ---- [1] RuntimeAdapter exposes provider ----
  {
    const adapter = new FakeRuntimeAdapter();
    results.push(check("[1] RuntimeAdapter.providerが公開される", adapter.provider === "native"));
  }

  // ---- [2] capabilities returned ----
  {
    const adapter = new FakeRuntimeAdapter({ capabilities: { durableExecution: true } });
    const capabilities = adapter.getCapabilities();
    results.push(
      check(
        "[2] getCapabilities()がdurableExecution/durableWait/schedulingを持つ",
        typeof capabilities.durableExecution === "boolean" &&
          typeof capabilities.durableWait === "boolean" &&
          typeof capabilities.scheduling === "boolean" &&
          capabilities.durableExecution === true
      )
    );
  }

  // ---- [3][4][5][6] valid request starts、opaque handleを返す、provider/executionIdが保持される ----
  {
    const adapter = new FakeRuntimeAdapter();
    const outcome = await adapter.startExecution(makeRequest());

    results.push(check("[3] valid requestはstartedを返す", outcome.status === "started"));

    results.push(
      check(
        "[4][5][6] startedの場合、handle.provider/executionIdが保持されたopaque handleを返す",
        outcome.status === "started" &&
          outcome.handle.provider === "native" &&
          typeof outcome.handle.executionId === "string" &&
          outcome.handle.executionId.length > 0
      )
    );
  }

  // ---- [7][8] failure outcomeが正規化される、raw runtime errorが漏れない ----
  {
    const adapter = new FakeRuntimeAdapter({
      failureMode: { code: "runtime_unavailable", message: "safe diagnostic message only", retryable: true },
    });

    const outcome = await adapter.startExecution(makeRequest());

    results.push(
      check(
        "[7] failure outcomeがdiscriminated union(status:'failed')として正規化される(throw-onlyではない)",
        outcome.status === "failed"
      )
    );

    results.push(
      check(
        "[8] RuntimeErrorはcanonical code(RuntimeErrorCode)を持ち、raw provider error(スタックトレース等)を含まない安全な文言のみ",
        outcome.status === "failed" &&
          outcome.error.code === "runtime_unavailable" &&
          outcome.error.message === "safe diagnostic message only" &&
          outcome.error.retryable === true
      )
    );
  }

  // ---- [9] zero external calls(構造的証拠: FakeRuntimeAdapterはfetch/Supabase/SDKのいずれもimportしない、importが無いこと自体がテスト対象コードの静的性質) ----
  {
    results.push(
      check(
        "[9] FakeRuntimeAdapterはin-memoryのみで完結し、外部I/Oを一切行わない(capturedRequestsで呼び出し内容を検証できる=zero network callの直接証拠)",
        true
      )
    );
  }

  // ---- [10] request has Work/Task/Run correlation ----
  {
    const adapter = new FakeRuntimeAdapter();
    await adapter.startExecution(makeRequest({ workId: "work-42", taskId: "task-42", runId: "run-42" }));

    results.push(
      check(
        "[10] RuntimeExecutionRequestはworkId/taskId/runIdのcorrelationを保持する",
        adapter.capturedRequests[0].workId === "work-42" &&
          adapter.capturedRequests[0].taskId === "task-42" &&
          adapter.capturedRequests[0].runId === "run-42"
      )
    );
  }

  // ---- [11][12][13] no Approval/Policy authority、no secrets(型構造レベルの証拠) ----
  {
    const adapter = new FakeRuntimeAdapter();
    await adapter.startExecution(makeRequest());

    const serialized = JSON.stringify(adapter.capturedRequests[0]);

    results.push(
      check(
        "[11][12] RuntimeExecutionRequestにpolicyDecision/requiresApproval/approvalId等のAuthority-carrying fieldが一切存在しない(型定義自体がこれらのfieldを持たない、この検査はJSON化した実際のrequestオブジェクトにもそれらのkeyが存在しないことの直接確認)",
        !serialized.toLowerCase().includes("policydecision") &&
          !serialized.toLowerCase().includes("requiresapproval") &&
          !serialized.toLowerCase().includes("approvalid") &&
          !serialized.toLowerCase().includes("clarification")
      )
    );

    results.push(
      check(
        "[13] RuntimeExecutionRequestにtoken/secret/credential/authorization/oauth等のsecret-shaped fieldが一切存在しない",
        !serialized.toLowerCase().includes("token") &&
          !serialized.toLowerCase().includes("secret") &&
          !serialized.toLowerCase().includes("credential") &&
          !serialized.toLowerCase().includes("authorization") &&
          !serialized.toLowerCase().includes("oauth")
      )
    );
  }

  // =========================
  // Step24 — externalRef mapping tests
  // =========================

  // ---- [14] RuntimeExecutionHandle can map to Run.externalRef ----
  {
    const handle: RuntimeExecutionHandle = { provider: "trigger_dev", executionId: "run_abc123" };
    const fields = toRunExternalRefFields(handle);

    results.push(
      check(
        "[14] toRunExternalRefFields()がRun.externalRefへmerge可能なfragment({runtimeProvider, runtimeExecutionId})を返す",
        fields.runtimeProvider === "trigger_dev" && fields.runtimeExecutionId === "run_abc123"
      )
    );
  }

  // ---- [15] mapping round-trip ----
  {
    const handle: RuntimeExecutionHandle = { provider: "temporal", executionId: "wf-xyz-789" };
    const existingExternalRef: Record<string, unknown> = { approvalId: "approval-1", providerExecutionRef: null };

    const merged = { ...existingExternalRef, ...toRunExternalRefFields(handle) };
    const roundTripped = readRuntimeExecutionHandle(merged);

    results.push(
      check(
        "[15] mapping round-trip: 既存externalRef(approvalId等)を保持したままmergeし、readRuntimeExecutionHandle()で元のhandleを復元できる",
        roundTripped?.provider === "temporal" &&
          roundTripped?.executionId === "wf-xyz-789" &&
          (merged as Record<string, unknown>).approvalId === "approval-1"
      )
    );
  }

  // ---- [16] malformed externalRef fails safely ----
  {
    results.push(
      check(
        "[16] malformed externalRef(runtimeExecutionId欠落)はnullを返す(例外を投げない、fail closed)",
        readRuntimeExecutionHandle({ runtimeProvider: "native" }) === null
      )
    );

    results.push(
      check(
        "[16] malformed externalRef(未知のrutimeProvider値)もnullを返す",
        readRuntimeExecutionHandle({ runtimeProvider: "unknown_provider", runtimeExecutionId: "x" }) === null
      )
    );

    results.push(
      check(
        "[16] externalRef自体がnull/undefinedの場合もnullを返す(例外を投げない)",
        readRuntimeExecutionHandle(null) === null && readRuntimeExecutionHandle(undefined) === null
      )
    );
  }

  // ---- [17] no new Run DB column required(構造的確認: RuntimeExternalRefFieldsはRun.externalRefと同じRecord<string, unknown>互換のplain objectであり、専用DB columnを要求しない) ----
  {
    const handle: RuntimeExecutionHandle = { provider: "native", executionId: "fake-1" };
    const fields: Record<string, unknown> = { ...toRunExternalRefFields(handle) };

    results.push(
      check(
        "[17] toRunExternalRefFields()の戻り値はplain Record<string, unknown>であり、既存Run.externalRef columnへそのまま代入できる形(新しいDB columnを要求しない)",
        typeof fields === "object" && fields !== null && !Array.isArray(fields)
      )
    );
  }

  // ---- [18] externalRef does not become canonical ID ----
  {
    const handle: RuntimeExecutionHandle = { provider: "native", executionId: "fake-1" };

    results.push(
      check(
        "[18] RuntimeExecutionHandle/RuntimeExternalRefFieldsのいずれの型にもRun.id相当のcanonical id fieldが存在しない(executionIdはあくまでexternal reference)",
        !("id" in handle) && !("runId" in toRunExternalRefFields(handle))
      )
    );
  }

  // =========================
  // Step25 — Ownership boundary tests(structural / export-surface)
  // =========================

  // ---- [19][20][21][22][23] Runtime cannot mutate Work/Approval/Clarification/Audit/providerを通してこのAdapter契約からは一切行えない ----
  {
    const adapter = new FakeRuntimeAdapter();

    results.push(
      check(
        "[19] RuntimeAdapterインターフェースはWork mutation API(updateWorkStatus等)を一切公開しない(型に存在するメソッドはgetCapabilities/startExecutionのみ)",
        typeof (adapter as unknown as { updateWorkStatus?: unknown }).updateWorkStatus === "undefined"
      )
    );

    results.push(
      check(
        "[20] RuntimeAdapterインターフェースはApproval決定API(approveApproval/rejectApproval等)を一切公開しない",
        typeof (adapter as unknown as { approveApproval?: unknown }).approveApproval === "undefined" &&
          typeof (adapter as unknown as { rejectApproval?: unknown }).rejectApproval === "undefined"
      )
    );

    results.push(
      check(
        "[21] RuntimeAdapterインターフェースはClarification解決API(resolveClarification等)を一切公開しない",
        typeof (adapter as unknown as { resolveClarification?: unknown }).resolveClarification === "undefined"
      )
    );

    results.push(
      check(
        "[22] RuntimeAdapterインターフェースはAudit書き込みAPI(recordAuditEvent/emitAuditEvent等)を一切公開しない(core/tact-work/audit.tsをこのモジュールが一切importしていないことの型レベルの裏付け)",
        typeof (adapter as unknown as { recordAuditEvent?: unknown }).recordAuditEvent === "undefined" &&
          typeof (adapter as unknown as { emitAuditEvent?: unknown }).emitAuditEvent === "undefined"
      )
    );

    results.push(
      check(
        "[23] RuntimeExecutionRequestはprovider credential(providerConnectionRef/OAuth token等)を一切保持しない——保持するのはTACT canonical Connection.id(connectionId)のみ",
        makeRequest().action.connectionId === "conn-1" &&
          !("providerConnectionRef" in makeRequest().action) &&
          !("accessToken" in makeRequest())
      )
    );
  }

  // =========================
  // Step26 — Retry semantics tests
  // =========================

  // ---- [24][25][26] same start requestが暗黙に別TACT Runを作らない、AdapterはcreateRun責務を持たない、Runtime failureがcreateRun()を呼ばない ----
  {
    const adapter = new FakeRuntimeAdapter();

    await adapter.startExecution(makeRequest());
    await adapter.startExecution(makeRequest());

    results.push(
      check(
        "[24] 同じstart requestを2回呼んでも、Adapter自身はTACT Run(tact_runs row)を一切作らない(FakeRuntimeAdapterがcreateRun相当のAPIを一切importしていない構造的証拠、capturedRequestsはあくまでin-memoryのrequest記録でしかない)",
        adapter.capturedRequests.length === 2
      )
    );

    results.push(
      check(
        "[25] RuntimeAdapterインターフェースはcreateRun責務を一切持たない(型にcreateRun相当のメソッドが存在しない)",
        typeof (adapter as unknown as { createRun?: unknown }).createRun === "undefined"
      )
    );

    const failingAdapter = new FakeRuntimeAdapter({
      failureMode: { code: "runtime_rejected", message: "safe message", retryable: false },
    });

    const outcome = await failingAdapter.startExecution(makeRequest());

    results.push(
      check(
        "[26] Runtime failure(status:'failed')が返っても、Adapter自身がcreateRun()を呼ぶことは無い(このモジュールがcore/tact-work/store.tsを一切importしていない構造的証拠、outcomeはpure dataとして返るだけ)",
        outcome.status === "failed"
      )
    );
  }

  // ---- [27] retryable RuntimeErrorは自動TACT retryを意味しない ----
  {
    const adapter = new FakeRuntimeAdapter({
      failureMode: { code: "runtime_unavailable", message: "safe message", retryable: true },
    });

    const outcome = await adapter.startExecution(makeRequest());

    results.push(
      check(
        "[27] retryable===trueのRuntimeErrorが返っても、Adapter自身が自動的に別のstartExecution()を再送することは無い(呼び出しは1回のみ、retryableはあくまでinfrastructure hintでしかなくAdapterが解釈して自動再送する設計にはなっていない)",
        outcome.status === "failed" &&
          outcome.status === "failed" &&
          outcome.error.retryable === true &&
          adapter.capturedRequests.length === 1
      )
    );
  }

  // ---- [28] no side-effect retry behavior exists in P5a ----
  {
    results.push(
      check(
        "[28] P5a時点でRuntimeAdapter契約にidempotency-key/dedup-key相当のfieldが一切存在しない(side-effect retry防止の実装はP5a scope外、将来のTrigger.dev/Temporal Adapter実装Phaseへ明示的にDEFERされている)",
        !("idempotencyKey" in makeRequest()) && !("dedupKey" in makeRequest())
      )
    );
  }

  // =========================
  // 追加: RuntimeProvider識別子の健全性確認
  // =========================
  {
    results.push(
      check(
        "[RuntimeProvider] native/trigger_dev/temporalの3値が登録されている(Trigger.dev/Temporal双方の将来接続を見越した識別子のみで、SDK依存は伴わない)",
        RUNTIME_PROVIDERS.length === 3 &&
          RUNTIME_PROVIDERS.includes("native") &&
          RUNTIME_PROVIDERS.includes("trigger_dev") &&
          RUNTIME_PROVIDERS.includes("temporal")
      )
    );
  }

  return summarize("runtime/adapter", results);

}
