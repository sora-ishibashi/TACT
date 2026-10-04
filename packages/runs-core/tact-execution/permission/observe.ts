// =========================
// TACT Canonical Execution — Permission Observation Orchestration (SOR-51 / SOR-52)
// =========================
//
// captureExecution()が成功した直後に呼ぶ、Evaluate + Persistをまとめた
// 入口。core/tact-bot/adapters/slack/observeSlackExecution.ts・
// core/tact-execution/adapters/notion/observeNotionMcpExecution.tsからは
// この1関数だけを呼ぶ——Adapter側がevaluatePermission()/
// persistPermissionDecision()を個別に組み立てない(責務分離、SOR-51指示
// 「観測系は本処理と責務を分離する」)。
//
// SOR-52で追加した責務: Permission Decisionの永続化直後に、Attention
// eligibilityを評価してpersistする(Work correlationを待たない、
// SOR-52指示section14)。絶対条件(SOR-52指示section15「Failure
// isolation」): Attention persistenceの失敗は、既に確定した
// Permission Decisionの永続化結果(このfunctionの戻り値)を一切変えず、
// 呼び出し元(Slack/Notion adapter)へ例外を伝播しない——silent
// failureにはせず、onFailureへ構造化して報告する。
//
// SOR-47 Phase2(Evaluator Cutover、Human Owner指示): deps.evaluatePermission
// のdefaultを、静的allowlist評価器(evaluate.tsのevaluatePermission()、
// sync)からDB-backed Permission Registry評価器
// (registryEvaluate.tsのevaluatePermissionForObservation()、async)へ
// 切り替える。evaluatePermission()自体(evaluate.ts)はtests/migration
// equivalence checks/明示的なdev utilities向けにそのまま残り、削除・
// 変更しない(Human Owner指示、絶対条件)——このfileのdefault配線
// だけが変わる。
//
// 絶対条件(Registry読み込み失敗、Human Owner指示section2、Option A):
// deps.evaluatePermission()がthrowした場合(RegistryUnavailableError、
// registryStore.ts参照)、この関数自身は一切catchせず、そのまま
// 呼び出し元(各adapterの既存Capture Failure Policy、独立した
// stage単位try/catch)へ伝播させる——「registryが読めなかった」ことを
// 「matchするruleが無かった」(unknown/no_matching_registry_rule、
// 正当なPermission Decision)へ静かに変換せず、誤ったPermission
// Decision provenanceを一切作らない。Attention persistence(下記)と
// 違い、この評価stage自体には意図的にtry/catchを設けない
// ——「stage自体の失敗は、その行を一切作らずstage境界の外側で
// isolateする」という、captureExecution()等ここまでの全stageと
// 共通のCapture Failure Policyをそのまま踏襲する。

import { evaluatePermissionForObservation } from "./registryEvaluate";
import { persistPermissionDecision, type PersistPermissionDecisionOutcome } from "./store";
import { deriveExecutionAttentionCandidate } from "./attention";
import { persistExecutionAttention } from "./attentionStore";
import type { PermissionDecision } from "./types";
import type { CanonicalExecution } from "../types";

export type ObserveExecutionPermissionFailureStage = "attention_persistence";

export interface ObserveExecutionPermissionDeps {

  // SOR-47 Phase2: asyncへ変更(DB-backed Registry評価器がdefaultに
  // なったため)。RegistryUnavailableError(またはその他の予期しない
  // 例外)をthrowし得る——このfunction自身は一切catchしない(上記
  // コメント参照)。
  evaluatePermission: (execution: CanonicalExecution) => Promise<PermissionDecision>;

  persistPermissionDecision: typeof persistPermissionDecision;

  deriveExecutionAttentionCandidate: typeof deriveExecutionAttentionCandidate;

  persistExecutionAttention: typeof persistExecutionAttention;

  onFailure: (stage: ObserveExecutionPermissionFailureStage, error: unknown) => void;

}

const defaultDeps: ObserveExecutionPermissionDeps = {

  // SOR-47 Phase2: DB-backed Permission Registry評価器がlive
  // observation pathのdefaultになる(Human Owner指示)。
  evaluatePermission: evaluatePermissionForObservation,
  persistPermissionDecision,
  deriveExecutionAttentionCandidate,
  persistExecutionAttention,

  onFailure: (stage, error) => {
    // captureExecution()/observeNotionMcpExecution.tsと同じ規律:
    // 生のexecution/decision内容やerrorをそのままログへ出さない
    // (Notion page本文等を含み得る)。安定したerror種別だけで十分。
    const errorKind = error instanceof Error ? error.name.slice(0, 100) : typeof error;
    console.error("[tact-execution/permission/observe] Attention observation failed", { stage, errorKind });
  },

};

// decisionが実際にDBへ存在する(=行のidを持つ)3variantだけがAttention
// 永続化の対象になり得る(invalid/execution_not_found/unavailable/error
// はそもそも参照できる行が無い)。
function decisionIdOf(outcome: PersistPermissionDecisionOutcome): string | undefined {
  return outcome.status === "persisted" || outcome.status === "already_evaluated" || outcome.status === "persisted_summary_sync_failed"
    ? outcome.decisionId
    : undefined;
}

export async function observeExecutionPermission(
  execution: CanonicalExecution,
  deps: ObserveExecutionPermissionDeps = defaultDeps
): Promise<PersistPermissionDecisionOutcome> {

  // 絶対条件(Human Owner指示section2、Option A): この呼び出しを
  // 意図的にtry/catchで囲まない。deps.evaluatePermission()が
  // RegistryUnavailableError(またはその他の予期しない例外)をthrow
  // した場合、そのまま呼び出し元(各adapterの既存Capture Failure
  // Policy)へ伝播させる——「registryが読めなかった」ことを「matchする
  // ruleが無かった」(正当なunknown decision)へ静かに変換しない。
  const decision = await deps.evaluatePermission(execution);
  const outcome = await deps.persistPermissionDecision(decision, execution.userId);

  const decisionId = decisionIdOf(outcome);

  // 絶対条件(SOR-52指示section15、Failure isolation): このtry/catchの
  // 結果は戻り値(outcome、既に確定したPermission Decisionの永続化
  // 結果)へ一切影響しない。
  if (decisionId) {

    try {

      const candidate = deps.deriveExecutionAttentionCandidate(execution, decision);

      // allowed/unknown(M-0原則)はcandidate=nullであり、Attentionを
      // 一切作らない(推測しない、絶対条件)。
      if (candidate) {

        const attentionOutcome = await deps.persistExecutionAttention(candidate, decisionId);

        if (attentionOutcome.status !== "persisted" && attentionOutcome.status !== "already_exists") {
          deps.onFailure("attention_persistence", new Error(`persistExecutionAttention returned ${attentionOutcome.status}`));
        }

      }

    } catch (error) {
      deps.onFailure("attention_persistence", error);
    }

  }

  return outcome;

}
