// =========================
// TACT Runtime — Integration Read Enablement
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// このfileだけがcore/tact-runtime/providers/triggerDev.ts(Trigger.dev
// SDK)をimportする、Trigger.devをRuntime routingへ実際に有効化するか
// どうかを決定する唯一のchokepoint。core/tact-runtime/index.tsの
// barrelからは再exportしない(絶対条件、providers/triggerDev.tsと
// 同じ理由——provider-neutral public contractへSDK依存を漏らさない)。
//
// 絶対条件(Step21/22): 明示的opt-inを1つだけ用意する(feature flag
// 乱立禁止)。
//   - flag未設定/false → 既存direct pathを維持(disabled)。
//   - flag=true かつ config有効 → Runtime routing有効(enabled)。
//   - flag=true かつ config不正 → fail closed。silent direct
//     fallbackはしない(misconfigured、Step22絶対条件: operator
//     intentと実際のexecution substrateがズレることを防ぐ)。
import {
  TriggerDevRuntimeAdapter,
  resolveTriggerDevConfigFromEnv,
  type TriggerDevEnvSource,
} from "./providers/triggerDev";
import type { RuntimeAdapter } from "./types";

export const RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY = "TACT_RUNTIME_TRIGGER_DEV_ENABLED";

export type RuntimeIntegrationReadResolution =
  | { status: "disabled" }
  | { status: "misconfigured" }
  | { status: "enabled"; adapter: RuntimeAdapter };

export function resolveRuntimeIntegrationReadAdapter(
  env: TriggerDevEnvSource = process.env
): RuntimeIntegrationReadResolution {

  if (env[RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY] !== "true") {
    return { status: "disabled" };
  }

  const config = resolveTriggerDevConfigFromEnv(env);

  if (!config) {
    return { status: "misconfigured" };
  }

  return { status: "enabled", adapter: new TriggerDevRuntimeAdapter(config) };

}
