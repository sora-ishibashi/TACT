// =========================
// TACT Bot — executeBotActions (BOT-P1)
// =========================
//
// Core/OrchestratorからBotへ返されたBotAction[]を、対応する
// ChannelAdapter経由で実際の外部チャットへ配送する。
//
// 絶対条件: 1つのActionの配送失敗が他のActionへ伝播しない
// (core/tact-orchestrator/executor.tsの「1 Taskの失敗が他Taskへ
// 伝播しない」という既存方針と同じ考え方をBot Gatewayでも踏襲する)。
// 対応するChannelAdapterが登録されていない場合(BOT-P1時点では
// Slack/LINE等いずれも未実装のため常にこの分岐に入る)も、例外を
// 投げず判別可能なBotActionDeliveryResultとして返す。

import type { BotAction, BotActionDeliveryResult } from "../types";
import type { ChannelAdapterRegistry } from "../adapters/types";

export async function executeBotActions(
  actions: BotAction[],
  adapters: ChannelAdapterRegistry
): Promise<BotActionDeliveryResult[]> {

  return Promise.all(
    actions.map(async (action): Promise<BotActionDeliveryResult> => {

      const adapter = adapters[action.target.channel];

      if (!adapter) {

        return {
          ok: false,
          actionKind: action.kind,
          error: `no ChannelAdapter registered for channel "${action.target.channel}"`,
        };

      }

      try {

        return await adapter.executeAction(action);

      } catch (error) {

        return {
          ok: false,
          actionKind: action.kind,
          error: error instanceof Error ? error.message : String(error),
        };

      }

    })
  );

}
