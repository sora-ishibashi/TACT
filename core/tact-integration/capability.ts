import { extractSlackSendIntent } from "../tact-intent/ruleRouter";
import { evaluatePolicyDecision } from "./policy";
import type { CapabilityInvocationRequest, CapabilityInvocationResult } from "../tact-orchestrator/types";

// =========================
// TACT Integration — "integration.slack.send_message" /
// "integration.slack.list_channels" Capabilities
// (Architecture Migration Phase C2.1b / C2.2)
// =========================
//
// core/tact-bootstrap.ts(合成ルート)がこれらの関数を
// registerCapability("integration.slack.*", ...)経由でCapability
// Registry(core/tact-core/capabilities/registry.ts)へ登録する。
// core/tact-orchestrator/executor.tsは"research"以外のCapability名に
// 対しては汎用のinvokeCapability()を直接呼ぶため(絶対条件12:
// Capability固有分岐を増やさない)、この関数はcore/tact-research/
// capabilityAdapter.tsのrunResearchCapability()のような変換Adapterを
// 介さず、CapabilityInvocationRequestを直接受け取る。
//
// 絶対条件(最重要、Phase C2.1b指示から継続): このfileはDBアクセス・
// Composio呼び出し・TACT Connection解決のいずれも行わない
// (accessToken自体がCapabilityInvocationRequest/CoreCapabilityの
// どちらにも存在しない——Capability層はTACT Coreの汎用Memory/
// Knowledge抽象しか持たず、Supabase RLS用のper-user access token
// を持たない設計であることをrepository調査で確認済み)。
//
// 絶対条件(Phase C2.2、Read/Write Policy): このfileはcore/tact-work/
// approval.tsのrequestApproval()を直接呼ばず、また「承認が必要か」を
// 自分で判断しない——core/tact-integration/policy.tsのcanonical
// PolicyDecision(Fast Port P2b、evaluatePolicyDecision())を参照し、
// その結果をTaskExecutionSummary.integrationRequirementとしてそのまま
// 運ぶだけにとどめる。実際にConnection解決・Approval作成・(read時の)
// 即時実行を行うのは、accessTokenを実際に持つcore/tact-work/
// execution.ts(runWorkTurn())の責務(絶対条件: 同一intentでTaskを
// 二重作成しない、Approval作成はcore/tact-work側に一元化する)。
//
// Fast Port P2b(docs/architecture/p2-p5-final-architecture.md
// Section5-9): 旧resolveIntegrationActionPolicy()呼び出しは
// evaluatePolicyDecision()へ置き換えた。requiresApprovalは
// policyDecision.decision==="require_approval"からの導出field
// として引き続き運ぶ(後方互換、値は変わらない)——live decisionの
// source of truthはintegrationRequirement.policyDecision(新規field、
// core/tact-orchestrator/task.tsのTaskIntegrationPolicyDecision)。
//
// 絶対条件(Correction2、canonical actionの単一表現): send_message
// (write)・list_channels(read)のいずれも、canonical action
// (service/operation/input)はintegrationRequirement.actionという
// 1箇所だけに表現する。旧approvalRequirement(Phase B3の汎用Approval
// 機構、Integration以外の将来Capabilityも使いうる)は、Integration
// Capability自身はもう使わない——同じaction情報を複数fieldへコピー
// してsource-of-truthを二重化しないため。

const SLACK_SERVICE = "slack";

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

  const operation = "send_message";

  // Fast Port P2b(絶対条件、Correction1を継承): policy allowlistに
  // 登録されていないactionは、たとえこの関数自体が呼ばれても実行可能
  // 扱いにしない(fail-closed)。send_messageはpolicy.ts上
  // require_approval(riskClass="write")として登録済みのため、通常
  // この分岐には到達しない——将来policy.ts側の登録が変更された場合に
  // 備えた防御的チェック(この関数はsend_message専用であり、
  // require_approval以外の値(allow/require_input/deny)はすべて
  // 「現在サポートされていない」として同じ扱いにする——複数のdecision
  // 値を個別に解釈しない、単一目的Capabilityとしての単純さを維持)。
  const decision = evaluatePolicyDecision(SLACK_SERVICE, operation);

  if (decision.decision !== "require_approval") {

    return {
      success: false,
      errorMessage: "この操作は現在サポートされていません。",
    };

  }

  return {

    success: true,

    // このTurnの回答として表示される。Connection解決前の時点では
    // 「承認が必要」であることまでしか断定できない(0件/複数件の場合の
    // 案内はcore/tact-work/execution.ts側がConnection解決後に
    // result.answerを上書きする、既存のOrchestrationResult変更なし
    // では表現しきれないため)。
    output: `Slack「${channel}」チャンネルへメッセージを送信する準備ができました。承認をお願いします。`,

    // Architecture Migration Phase C2.2: canonical actionをここ1箇所
    // だけで表現する(Correction2、旧approvalRequirementは使わない)。
    integrationRequirement: {

      // Fast Port P2b: requiresApprovalは後方互換のための導出field
      // (decision.decision==="require_approval"と常に同値)。
      requiresApproval: true,

      // Fast Port P2b: live decisionのsource of truth。
      // core/tact-work/execution.tsのonTaskFinished()はこの値で
      // exhaustive switchする。
      policyDecision: decision.decision,

      reason: "外部SaaS(Slack)への投稿には承認が必要です",

      // Architecture Migration ARCH-P1b: このrequirementを判定した
      // 時点のcanonical risk classificationをそのまま運ぶ(Approval
      // Subject.riskClassSnapshotの唯一のsource、
      // docs/architecture/approval-integrity.md Step4参照)。
      riskClass: decision.riskClass,

      action: {

        kind: "integration_action",

        summary: `Slack「${channel}」チャンネルへメッセージを送信します`,

        // Provider固有の識別子(Composio tool slug/connectedAccountId等)
        // は一切含まない——canonical actionのみ(絶対条件)。
        // connectionIdはまだ含めない(core/tact-work/execution.tsが
        // Connection解決後に追加する)。
        metadata: {
          service: SLACK_SERVICE,
          operation,
          input: { channel, text },
        },

      },

    },

  };

}

// =========================
// "integration.slack.list_channels" (Architecture Migration Phase C2.2)
// =========================
//
// read-only capability。入力はSlackワークスペース全体が対象のため
// 必須fieldを持たない({}、ユーザー指示Section6)。channel名等の
// provider都合のfieldをcanonical inputへ追加しない。requestからの
// 抽出が不要なため、引数自体を持たない(呼び出し側はCapabilityHandler/
// invokeCapability()経由でrequestを渡すが、この関数は使わないだけ
// ——既存のdefaultResolveIntegrationConnection()と同じ既存パターン)。
export async function runIntegrationSlackListChannelsCapability(): Promise<CapabilityInvocationResult> {

  const operation = "list_channels";

  const decision = evaluatePolicyDecision(SLACK_SERVICE, operation);

  // Fast Port P2b(絶対条件、Correction1を継承): decisionが"allow"以外
  // (未登録/require_approval/require_input/deny)の場合、
  // requiresApproval=trueへ安全側fallbackせず「実行そのものを拒否
  // する」。通常この分岐には到達しない(list_channelsはpolicy.ts上
  // allow(riskClass="read")として登録済み)が、将来policy.ts側の
  // 登録が変更された場合に備えた防御的チェック(この関数はread専用
  // Capabilityであり、allow以外はすべて同じ「サポートされていない」
  // 扱いにする)。
  if (decision.decision !== "allow") {

    return {
      success: false,
      errorMessage: "この操作は現在サポートされていません。",
    };

  }

  return {

    success: true,

    output: "Slackのチャンネル一覧を取得する準備ができました。",

    integrationRequirement: {

      // decision.decision==="allow"のため常にfalse
      // (evaluatePolicyDecision()から導出済みの値をそのまま運ぶ、
      // このfile自身は「readだから承認不要」という判断を独自にしない)。
      requiresApproval: false,

      // Fast Port P2b: live decisionのsource of truth。
      policyDecision: decision.decision,

      // Architecture Migration ARCH-P1b: readはApprovalを一切経由
      // しない(絶対条件Correction2)ためriskClassSnapshotが実際に
      // 使われることはないが、writeと同じ形で一貫して運んでおく。
      riskClass: decision.riskClass,

      action: {

        kind: "integration_action",

        summary: "Slackのチャンネル一覧を取得します",

        metadata: {
          service: SLACK_SERVICE,
          operation,
          input: {},
        },

      },

    },

  };

}
