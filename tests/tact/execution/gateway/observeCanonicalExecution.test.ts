// =========================
// TACT Canonical Execution — Generic Observation Gateway Regression (SOR-129)
// =========================
//
// 対象: core/tact-execution/gateway/observeCanonicalExecution.tsの
// orchestration分岐(normalize結果を受け取ってからcapture→permission→
// correlation、失敗の隔離)。core/tact-execution/adapters/notion/
// observeNotionMcpExecution.tsのそれと同じ分岐を、provider中立な
// 入力(ExecutionAdapterNormalizeResult)で直接検証する——Notion固有の
// normalizerを経由しない、Gateway自身の契約テスト。既存のNotion
// regression(tests/tact/execution/adapters/notionMcpObservation.test.ts)
// が「Notionを通しても同じ結果になる」ことを別途保証する。

import { observeCanonicalExecution } from "../../../../core/tact-execution/gateway/observeCanonicalExecution";
import type { ObservationSource, ObserveCanonicalExecutionDeps } from "../../../../core/tact-execution/gateway/types";
import type { ExecutionAdapterNormalizeResult } from "../../../../core/tact-execution/adapters/types";
import type { CanonicalExecution, CaptureExecutionInput } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

const source: ObservationSource = {
  userId: "user-1",
  provider: "custom",
  connectionId: "connection-1",
  adapterVersion: "generic-test-adapter-v1",
};

function baseCaptureInput(overrides: Partial<CaptureExecutionInput> = {}): CaptureExecutionInput {
  return {
    userId: "user-1",
    actorKind: "service",
    provider: "custom",
    sourceType: "runtime_dispatch",
    externalEventId: "evt-1",
    adapterVersion: "generic-test-adapter-v1",
    actionCategory: "execute",
    operation: "generic_test_operation",
    ...overrides,
  };
}

function okNormalizeResult(overrides: Partial<CaptureExecutionInput> = {}): ExecutionAdapterNormalizeResult {
  return { ok: true, input: baseCaptureInput(overrides) };
}

function capturedOutcome(executionOverrides: Partial<CanonicalExecution> = {}) {
  return {
    status: "captured" as const,
    execution: { permissionStatus: "unknown", ...executionOverrides } as CanonicalExecution,
  };
}

function noopPermission(): ObserveCanonicalExecutionDeps["observeExecutionPermission"] {
  return async () => ({ status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" });
}

function noopCorrelation(): ObserveCanonicalExecutionDeps["observeExecutionWorkCorrelation"] {
  return async () => ({ status: "persisted" as const, decision: {} as never });
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: normalization失敗 -> stage='normalization'で隔離される、captureは一切呼ばれない ----
  {
    const failures: string[] = [];
    let captureCalled = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => { captureCalled = true; return capturedOutcome(); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };

    await observeCanonicalExecution({ ok: false, reason: "unsupported event shape" }, source, deps);

    results.push(
      check(
        "[Test1] normalization失敗はstage='normalization'で隔離され、captureExecutionは呼ばれない",
        failures.length === 1 && failures[0] === "normalization" && !captureCalled
      )
    );
  }

  // ---- Test2: capture例外 -> stage='capture'で隔離される、permission/correlationは呼ばれない ----
  {
    const failures: string[] = [];
    let permissionCalled = false;
    let correlationCalled = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => { throw new Error("database unavailable"); },
      observeExecutionPermission: async (e) => { permissionCalled = true; return noopPermission()(e); },
      observeExecutionWorkCorrelation: async (e) => { correlationCalled = true; return noopCorrelation()(e); },
      onFailure: (stage) => failures.push(stage),
    };

    await observeCanonicalExecution(okNormalizeResult(), source, deps);

    results.push(
      check(
        "[Test2] captureExecution()の例外はstage='capture'で隔離され、permission/correlationは呼ばれない",
        failures.length === 1 && failures[0] === "capture" && !permissionCalled && !correlationCalled
      )
    );
  }

  // ---- Test3: captureがinvalid/unavailable/errorを返した場合もstage='capture'として扱う ----
  {
    for (const status of ["invalid", "unavailable", "error"] as const) {
      const failures: string[] = [];

      const deps: ObserveCanonicalExecutionDeps = {
        captureExecution: async () =>
          status === "invalid"
            ? { status: "invalid", errors: ["boom"] }
            : status === "unavailable"
              ? { status: "unavailable" }
              : { status: "error", message: "boom" },
        observeExecutionPermission: noopPermission(),
        observeExecutionWorkCorrelation: noopCorrelation(),
        onFailure: (stage) => failures.push(stage),
      };

      await observeCanonicalExecution(okNormalizeResult(), source, deps);

      results.push(
        check(
          `[Test3] captureExecution()がstatus='${status}'を返した場合もstage='capture'として隔離される`,
          failures.length === 1 && failures[0] === "capture"
        )
      );
    }
  }

  // ---- Test4: 正常経路 -> permissionStatus='pending'ならpermission評価を呼び、correlationも常に呼ぶ ----
  {
    let permissionCalled = false;
    let correlationCalled = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "pending" }),
      observeExecutionPermission: async (e) => { permissionCalled = true; return noopPermission()(e); },
      observeExecutionWorkCorrelation: async (e) => { correlationCalled = true; return noopCorrelation()(e); },
      onFailure: () => undefined,
    };

    await observeCanonicalExecution(okNormalizeResult(), source, deps);

    results.push(
      check(
        "[Test4] permissionStatus='pending'ならobserveExecutionPermission()を呼び、observeExecutionWorkCorrelation()も呼ぶ",
        permissionCalled && correlationCalled
      )
    );
  }

  // ---- Test5: permissionStatusが'pending'以外(既に評価済み/duplicate) -> permission評価をskip、correlationは呼ぶ ----
  {
    let permissionCalled = false;
    let correlationCalled = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "unknown" }),
      observeExecutionPermission: async (e) => { permissionCalled = true; return noopPermission()(e); },
      observeExecutionWorkCorrelation: async (e) => { correlationCalled = true; return noopCorrelation()(e); },
      onFailure: () => undefined,
    };

    await observeCanonicalExecution(okNormalizeResult(), source, deps);

    results.push(
      check(
        "[Test5] permissionStatusが既に'pending'以外ならobserveExecutionPermission()はskipされる(duplicate captureの安全な再試行、既存挙動と同一)",
        !permissionCalled && correlationCalled
      )
    );
  }

  // ---- Test6/isolation: permission評価の失敗はcorrelationの実行を妨げない ----
  {
    const failures: string[] = [];
    let correlationCalled = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "pending" }),
      observeExecutionPermission: async () => { throw new Error("permission evaluator crashed"); },
      observeExecutionWorkCorrelation: async (e) => { correlationCalled = true; return noopCorrelation()(e); },
      onFailure: (stage) => failures.push(stage),
    };

    await observeCanonicalExecution(okNormalizeResult(), source, deps);

    results.push(
      check(
        "[Test6] Permission評価の失敗はstage='permission_evaluation'として隔離され、Work Correlationの実行を妨げない",
        failures.length === 1 && failures[0] === "permission_evaluation" && correlationCalled
      )
    );
  }

  // ---- Test7/isolation: correlationの失敗は例外として伝播しない ----
  {
    const failures: string[] = [];
    let observeThrew = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => capturedOutcome(),
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: async () => { throw new Error("correlator crashed"); },
      onFailure: (stage) => failures.push(stage),
    };

    try {
      await observeCanonicalExecution(okNormalizeResult(), source, deps);
    } catch {
      observeThrew = true;
    }

    results.push(
      check(
        "[Test7] Work Correlationの失敗はstage='work_correlation'として隔離され、呼び出し元へ例外を伝播させない",
        !observeThrew && failures.length === 1 && failures[0] === "work_correlation"
      )
    );
  }

  // ---- 参考: recordIngestionFailure()は省略可能(best-effort、無くても動作する) ----
  {
    let threw = false;

    const deps: ObserveCanonicalExecutionDeps = {
      captureExecution: async () => { throw new Error("boom"); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => undefined,
      // recordIngestionFailure省略
    };

    try {
      await observeCanonicalExecution(okNormalizeResult(), source, deps);
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[Ref] recordIngestionFailureを省略しても例外を投げない(optional dep)",
        !threw
      )
    );
  }

  return summarize("SOR-129 — Generic Observation Gateway", results);

}
