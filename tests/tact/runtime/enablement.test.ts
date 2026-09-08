// =========================
// TACT Runtime — Integration Read Enablement Regression
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// 対象: core/tact-runtime/enablement.tsのresolveRuntimeIntegrationReadAdapter()。
// 実process.envは一切変更しない(injected envオブジェクトのみを使う)。
// TriggerDevRuntimeAdapterのconstructorはconfigure()(SDK内部の
// global state設定のみ、network I/Oなし)を呼ぶだけであり、実
// Trigger.dev networkへは一切接続しない。
import { resolveRuntimeIntegrationReadAdapter, RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY } from "../../../core/tact-runtime/enablement";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] runtime flag absent -> disabled(既存direct pathを維持) ----
  {
    const resolution = resolveRuntimeIntegrationReadAdapter({});
    results.push(check("[1] flag未設定 -> disabled", resolution.status === "disabled"));
  }

  // ---- [2] runtime flag false -> disabled ----
  {
    const resolution = resolveRuntimeIntegrationReadAdapter({ [RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY]: "false" });
    results.push(check("[2] flag='false' -> disabled", resolution.status === "disabled"));
  }

  // ---- [3] flag true + config valid -> enabled(Trigger runtime選択) ----
  {
    const resolution = resolveRuntimeIntegrationReadAdapter({
      [RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY]: "true",
      TRIGGER_SECRET_KEY: "tr_dev_test",
    });

    results.push(
      check(
        "[3] flag=true かつ config有効 -> enabled、adapter.provider==='trigger_dev'",
        resolution.status === "enabled" && resolution.adapter.provider === "trigger_dev"
      )
    );
  }

  // ---- [6] flag true + invalid config -> misconfigured(fail closed、silent direct fallbackしない) ----
  {
    const resolution = resolveRuntimeIntegrationReadAdapter({
      [RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY]: "true",
      // TRIGGER_SECRET_KEY未設定 = 不正なconfig
    });

    results.push(
      check(
        "[6] flag=true かつ config不正(TRIGGER_SECRET_KEY未設定) -> misconfigured(disabledとは別のstatus、silent fallbackを防ぐ)",
        resolution.status === "misconfigured"
      )
    );
  }

  // ---- flagの値が'true'という正確な文字列以外(例: '1'、'TRUE'、余分な空白)は有効化しない、という安全側デフォルトの確認 ----
  {
    const resolution1 = resolveRuntimeIntegrationReadAdapter({ [RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY]: "1" });
    const resolution2 = resolveRuntimeIntegrationReadAdapter({ [RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY]: "TRUE" });

    results.push(
      check(
        "[flag厳密一致] '1'や'TRUE'等、'true'の正確な文字列以外はdisabledのまま(feature flag乱立防止、厳密な単一opt-in)",
        resolution1.status === "disabled" && resolution2.status === "disabled"
      )
    );
  }

  return summarize("runtime/enablement", results);

}
