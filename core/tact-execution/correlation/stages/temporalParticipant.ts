// =========================
// TACT Canonical Execution — Temporal/Participant Candidate Resolver
// (SOR-52)
// =========================
//
// Correlation Methods優先順位3。「必要な場合のみ」使う弱い候補集合
// (直近activeだったWork)を返すだけの段階——絶対条件(SOR-52指示):
// これだけで自動確定しない。決定は次のstage(ai_assisted、
// stages/aiAssisted.ts)が行う。
//
// Inactive/invalid Work(completed/failed/cancelled)は候補から除外
// する——「試したが対象外だった」ではなく、そもそも候補集合に
// 入れない(Tests要件「inactive/invalid Work」)。

// SOR-135 Phase 1 (Runs isolation): no static import of core/tact-work
// here — Work data is reached only through the product-neutral
// WorkProjectionRepository contract (core/execution-contract), resolved
// lazily through the registry (../../projection/registry).
import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../../database/supabaseServiceRole";
import { getWorkProjectionRepository } from "../../projection/registry";
import type { WorkReference, WorkProjectionRepository } from "../../../execution-contract";
import type { CorrelationContext } from "../types";

const ACTIVE_WORK_STATUSES: readonly string[] = [
  "created",
  "planning",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
];

export interface TemporalParticipantCandidateDeps {

  listRecentWorksForUser: WorkProjectionRepository["listRecentWorksForUser"];

  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

// 遅延解決(絶対条件、SOR-135): structural.ts/store.tsと同じ設計。
export const defaultTemporalParticipantCandidateDeps: TemporalParticipantCandidateDeps = {
  listRecentWorksForUser: (userId, accessToken, options) =>
    getWorkProjectionRepository().listRecentWorksForUser(userId, accessToken, options),
  getServiceRoleKey: defaultGetServiceRoleKey,
};

export async function resolveTemporalParticipantCandidates(
  context: CorrelationContext,
  deps: TemporalParticipantCandidateDeps = defaultTemporalParticipantCandidateDeps
): Promise<WorkReference[]> {

  const accessToken = deps.getServiceRoleKey();

  if (!accessToken) {
    return [];
  }

  const recentWorks = await deps.listRecentWorksForUser(context.userId, accessToken, { limit: 5 });

  return recentWorks.filter((work) => ACTIVE_WORK_STATUSES.includes(work.status));

}
