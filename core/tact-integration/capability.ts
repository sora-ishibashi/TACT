import { extractSlackSendIntent } from "../tact-intent/ruleRouter";
import type { CapabilityInvocationRequest, CapabilityInvocationResult } from "../tact-orchestrator/types";

// =========================
// TACT Integration — "integration.slack.send_message" Capability
// (Architecture Migration Phase C2.1b)
// =========================
//
// core/tact-bootstrap.ts(合成ルート)がこの関数を
// registerCapability("integration.slack.send_message", ...)経由で
// Capability Registry(core/tact-core/capabilities/registry.ts)へ
// 登録する。core/tact-orchestrator/executor.tsは"research"以外の
// Capability名に対しては汎用のinvokeCapability()を直接呼ぶため
// (絶対条件12: Capability固有分岐を増やさない)、この関数は
// core/tact-research/capabilityAdapter.tsのrunResearchCapability()の
// ような変換Adapterを介さず、CapabilityInvocationRequestを直接受け取る。
//
// 絶対条件(最重要、Phase C2.1b指示): このfileはDBアクセス・
// Composio呼び出し・TACT Connection解決のいずれも行わない
// (accessToken自体がCapabilityInvocationRequest/CoreCapabilityの
// どちらにも存在しない——Capability層はTACT Coreの汎用Memory/
// Knowledge抽象しか持たず、Supabase RLS用のper-user access token
// を持たない設計であることをrepository調査で確認済み)。
//
// 実際の外部write実行に必要な手順(TACT Connection解決・
// proposeIntegrationAction()相当のApproval作成)は、accessTokenを
// 実際に持つcore/tact-work/execution.ts(runWorkTurn())の
// approvalRequirement処理へ委譲する——このCapabilityは、既存の
// Phase B3 approvalRequirement機構(TaskApprovalRequirement、
// core/tact-orchestrator/task.ts)を使って「このTaskは人間承認が
// 必要な外部writeを提案している」という信号を返すだけにとどまる。
// これにより、proposeIntegrationAction()を別途呼ばず、Planner
// (decomposeTask())が既に作成済みのTaskをそのままApprovalへ紐づける
// ことができる(絶対条件: 同一intentでTaskを二重作成しない)。
//
// canonical action(service/operation/input)はcore/tact-work/
// execution.tsのApproval作成処理がそのままpayload.action.metadataへ
// 保存し、既存のcore/tact-integration/execution.tsの
// extractIntegrationActionFromApproval()がPhase C1と全く同じ形式で
// 解釈できる(service:"slack", operation:"send_message",
// input:{channel,text})。connectionIdはこの時点では未確定
// (Connection解決はcore/tact-work/execution.ts側の責務)。

export async function runIntegrationSlackSendMessageCapability(
  request: CapabilityInvocationRequest
): Promise<CapabilityInvocationResult> {

  // Routing層(core/tact-intent/ruleRouter.tsのclassifyIntent()、
  // core/tact-orchestrator/ambiguityDetector.tsのdetectAmbiguity())が
  // 既にchannel/textの両方を確認済みのはずだが、この関数は独立して
  // 呼ばれうる(Capability Registry経由の直接呼び出し)ため、防御的に
  // 再抽出する。何らかの理由で抽出できない場合も例外を投げず、安全に
  // 失敗として扱う(絶対条件17と同じ精神: Capability呼び出しは
  // 例外を外へ投げない)。
  const extracted = extractSlackSendIntent(request.query);

  if (!extracted.matched || "missing" in extracted) {

    return {
      success: false,
      errorMessage:
        "Slack送信に必要なchannel/textを特定できませんでした(routing層と結果が一致しません)。",
    };

  }

  const { channel, text } = extracted;

  return {

    success: true,

    // このTurnの回答として表示される。Connection解決前の時点では
    // 「承認が必要」であることまでしか断定できない(0件/複数件の場合の
    // 案内はcore/tact-work/execution.ts側がConnection解決後に
    // result.answerを上書きする、既存のOrchestrationResult変更なし
    // では表現しきれないため)。
    output: `Slack「${channel}」チャンネルへメッセージを送信する準備ができました。承認をお願いします。`,

    // Architecture Migration Phase B3の既存機構をそのまま使う
    // (絶対条件: 新しいApproval経路を作らない)。
    approvalRequirement: {

      reason: "外部SaaS(Slack)への投稿には承認が必要です",

      action: {

        kind: "integration_action",

        summary: `Slack「${channel}」チャンネルへメッセージを送信します`,

        // Provider固有の識別子(Composio tool slug/connectedAccountId等)
        // は一切含まない——canonical actionのみ(絶対条件)。
        // connectionIdはまだ含めない(core/tact-work/execution.tsが
        // Connection解決後に追加する)。
        metadata: {
          service: "slack",
          operation: "send_message",
          input: { channel, text },
        },

      },

    },

  };

}
