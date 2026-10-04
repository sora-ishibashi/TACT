// =========================
// TACT Canonical Execution — Permission Observation Orchestration (SOR-51 / SOR-52 / SOR-178)
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
// SOR-178 / SEC-8D cutover(重要): decision.statusによってAttention
// episode生成の経路を分ける(Human Owner Decision B/C)。
//   - approval_required: 既存のderiveExecutionAttentionCandidate()→
//     persistExecutionAttention()経路(変更なし)。
//   - denied/unknown: SecurityFinding導出→永続化→
//     ensure_security_finding_attention_link() RPC経由でAttention
//     episodeへensure/link(../securityFinding/observe.tsの
//     observeRunsPermissionSecurityFinding())。deriveExecutionAttentionCandidate()
//     はこの2つのstatusに対してもう呼ばれない(attention.ts参照)。
//   - allowed: 何もしない。
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
// Decision provenanceを一切作らない。Attention/SecurityFinding
// persistence(下記)と違い、この評価stage自体には意図的にtry/catchを
// 設けない——「stage自体の失敗は、その行を一切作らずstage境界の外側で
// isolateする」という、captureExecution()等ここまでの全stageと
// 共通のCapture Failure Policyをそのまま踏襲する。

import { evaluatePermissionForObservation } from "./registryEvaluate";
import { persistPermissionDecision, type PersistPermissionDecisionOutcome } from "./store";
import { deriveExecutionAttentionCandidate } from "./attention";
import { persistExecutionAttention } from "./attentionStore";
import {
  observeRunsPermissionSecurityFinding,
  DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,
  type ConfiguredUnknownAlertRule,
} from "../securityFinding";
import type { PermissionDecision } from "./types";
import type { CanonicalExecution } from "../types";

export type ObserveExecutionPermissionFailureStage =
  | "attention_persistence"
  | "security_finding_persistence"
  | "security_finding_attention_link";

export interface ObserveExecutionPermissionDeps {

  // SOR-47 Phase2: asyncへ変更(DB-backed Registry評価器がdefaultに
  // なったため)。RegistryUnavailableError(またはその他の予期しない
  // 例外)をthrowし得る——このfunction自身は一切catchしない(上記
  // コメント参照)。
  evaluatePermission: (execution: CanonicalExecution) => Promise<PermissionDecision>;

  persistPermissionDecision: typeof persistPermissionDecision;

  deriveExecutionAttentionCandidate: typeof deriveExecutionAttentionCandidate;

  persistExecutionAttention: typeof persistExecutionAttention;

  // SOR-178 / SEC-8D: denied/unknownのSecurityFinding導出+永続化+
  // Attention ensure/link。approval_requiredにはこのdepsは使われない
  // (上記コメントのDecision B/C参照)。
  observeRunsPermissionSecurityFinding: typeof observeRunsPermissionSecurityFinding;

  // section4 DECISION E: 既定は空配列。未配線の呼び出し元は常に
  // HIGH_IMPACT_UNKNOWNのみを評価する(configured UNKNOWNは一切発生
  // しない)——DB-backed policy engineをこのSliceで新設しない。
  configuredUnknownAlertRules: readonly ConfiguredUnknownAlertRule[];

  onFailure: (stage: ObserveExecutionPermissionFailureStage, error: unknown) => void;

}

const defaultDeps: ObserveExecutionPermissionDeps = {

  // SOR-47 Phase2: DB-backed Permission Registry評価器がlive
  // observation pathのdefaultになる(Human Owner指示)。
  evaluatePermission: evaluatePermissionForObservation,
  persistPermissionDecision,
  deriveExecutionAttentionCandidate,
  persistExecutionAttention,
  observeRunsPermissionSecurityFinding,
  configuredUnknownAlertRules: DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,

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
  // 結果)へ一切影響しない。SOR-178後も同じ精神をdenied/unknown経路
  // (SecurityFinding)へ拡張する。
  if (decisionId) {

    if (decision.status === "approval_required") {

      // Decision B(SOR-178): approval_requiredはgovernance workflowであり
      // security violationではない。既存経路のまま——変更しない。
      try {

        const candidate = deps.deriveExecutionAttentionCandidate(execution, decision);

        if (candidate) {

          const attentionOutcome = await deps.persistExecutionAttention(candidate, decisionId);

          if (attentionOutcome.status !== "persisted" && attentionOutcome.status !== "already_exists") {
            deps.onFailure("attention_persistence", new Error(`persistExecutionAttention returned ${attentionOutcome.status}`));
          }

        }

      } catch (error) {
        deps.onFailure("attention_persistence", error);
      }

    } else if (decision.status === "denied" || decision.status === "unknown") {

      // Decision C(SOR-178): denied/unknownはSecurityFinding導出→
      // 永続化→ensure_security_finding_attention_link() RPC経由での
      // Attention ensure/linkに完全移行した。deriveExecutionAttentionCandidate()
      // はこの2つのstatusに対して呼ばない(attention.ts参照)。
      try {

        const findingOutcome = await deps.observeRunsPermissionSecurityFinding(
          execution,
          decision,
          decisionId,
          deps.configuredUnknownAlertRules
        );

        if (findingOutcome.status === "finding_persistence_failed") {
          deps.onFailure(
            "security_finding_persistence",
            new Error(`observeRunsPermissionSecurityFinding: finding persistence failed (${findingOutcome.reason})`)
          );
        } else if (findingOutcome.status === "attention_link_failed") {
          deps.onFailure(
            "security_finding_attention_link",
            new Error(`observeRunsPermissionSecurityFinding: attention link failed for finding ${findingOutcome.findingId} (${findingOutcome.reason})`)
          );
        }

        // "not_eligible"/"linked": no failure to report (never guess a
        // failure when the structured outcome says there is none).

      } catch (error) {
        deps.onFailure("security_finding_persistence", error);
      }

    }

    // allowed: nothing to do (not reached here when decisionId exists for
    // reasons other than those three statuses — allowed never produces a
    // candidate/Finding, by construction of both derive paths).

  }

  return outcome;

}
