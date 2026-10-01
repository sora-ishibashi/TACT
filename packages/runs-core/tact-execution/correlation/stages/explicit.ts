// =========================
// TACT Canonical Execution — Deterministic/Explicit Correlator (SOR-52)
// =========================
//
// Correlation Methods優先順位1(最優先、AI推論を使わない)。Execution
// 自身に既にWork参照が存在する場合(例: core/tact-runtime経由のRuntime
// dispatchがcapture時点でworkIdを供給済み)に確定させる。pure関数
// (DBアクセス無し)。

import type { CanonicalExecution } from "../../types";
import type { WorkCorrelationDecision } from "../types";
import { CORRELATOR_VERSION } from "../version";
import { EXPLICIT_CONFIDENCE } from "../confidencePolicy";

// null(=このstageでは決められない、次のstageへ委ねる)を返す規律は
// stages/structural.ts・stages/temporalParticipant.tsと共通。
export function runExplicitCorrelation(execution: CanonicalExecution): WorkCorrelationDecision | null {

  if (!execution.workId) {
    return null;
  }

  return {
    executionId: execution.id,
    status: "matched",
    workId: execution.workId,
    method: "explicit",
    confidence: EXPLICIT_CONFIDENCE,
    reasonCode: "work_id_already_set_at_capture",
    correlatorVersion: CORRELATOR_VERSION,
    candidateWorkIds: [execution.workId],
    correlatedAt: new Date().toISOString(),
  };

}
