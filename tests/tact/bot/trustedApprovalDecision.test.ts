// =========================
// TACT Bot — Trusted Approval Decision Boundary Regression
// (Architecture Migration Phase C2.1c-b)
// =========================
//
// 対象: core/tact-bot/execution/trustedApprovalDecision.tsの
// handleApprovalDecisionAsTrustedActor()。
//
// 環境制約(core/tact-bot/execution/trustedConversationTurn.test.ts
// と同じ既存方針): このtest実行環境にはSUPABASE_SERVICE_ROLE_KEYが
// 設定されていない。そのため、ここではmockを使わず実関数をそのまま
// 呼び出し、「未設定時は一切DBへアクセスせず安全にfallbackする」
// という分岐だけを確認する(Category A、pure/deterministic)。
// 「設定済み」経路(実Supabase書き込み、approveApproval()/
// rejectApproval()自体の呼び出し)は、tests/tact/bot/
// receiveApprovalDecision.test.tsがfake handleDecision経由でGateway
// 層のロジックを検証する形で補完し、ここではテストしない
// (trustedConversationTurn.test.tsと同じ既存repository方針)。

import "dotenv/config";
import { handleApprovalDecisionAsTrustedActor } from "../../../core/tact-bot/execution/trustedApprovalDecision";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYが未設定である(設定済みの場合、以下のtestは実Supabase書き込みを試みてしまうため、前提条件として確認する)",
      isServiceRoleConfigured() === false
    )
  );

  const approveResult = await handleApprovalDecisionAsTrustedActor({
    tactUserId: "tact-user-1",
    workId: "work-1",
    approvalId: "approval-1",
    decision: "approve",
  });

  results.push(
    check(
      "[Test1-1] service role未設定時、approve decisionはok:false・error:trusted_execution_not_configuredを返す(DBへ一切アクセスしない)",
      approveResult.ok === false && approveResult.error === "trusted_execution_not_configured"
    )
  );

  const rejectResult = await handleApprovalDecisionAsTrustedActor({
    tactUserId: "tact-user-1",
    workId: "work-1",
    approvalId: "approval-1",
    decision: "reject",
    reason: "テスト",
  });

  results.push(
    check(
      "[Test1-2] service role未設定時、reject decisionも同じく安全にfallbackする(引数に関わらず未設定なら常にDBへアクセスしない)",
      rejectResult.ok === false && rejectResult.error === "trusted_execution_not_configured"
    )
  );

  results.push(
    check(
      "[Test1-3] エラー結果にservice role key等の生Credentialが含まれない",
      !JSON.stringify(approveResult).toLowerCase().includes("bearer") &&
        !JSON.stringify(approveResult).includes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "__unset__")
    )
  );

  return summarize("bot/trustedApprovalDecision", results);

}
