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

import { listRecentWorksForUser as defaultListRecentWorksForUser } from "../../../tact-work/store";
import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../../database/supabaseServiceRole";
import type { Work, WorkStatus } from "../../../tact-work/types";
import type { CorrelationContext } from "../types";

const ACTIVE_WORK_STATUSES: readonly WorkStatus[] = [
  "created",
  "planning",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
];

export interface TemporalParticipantCandidateDeps {

  listRecentWorksForUser: typeof defaultListRecentWorksForUser;

  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

export const defaultTemporalParticipantCandidateDeps: TemporalParticipantCandidateDeps = {
  listRecentWorksForUser: defaultListRecentWorksForUser,
  getServiceRoleKey: defaultGetServiceRoleKey,
};

export async function resolveTemporalParticipantCandidates(
  context: CorrelationContext,
  deps: TemporalParticipantCandidateDeps = defaultTemporalParticipantCandidateDeps
): Promise<Work[]> {

  const accessToken = deps.getServiceRoleKey();

  if (!accessToken) {
    return [];
  }

  const recentWorks = await deps.listRecentWorksForUser(context.userId, accessToken, { limit: 5 });

  return recentWorks.filter((work) => ACTIVE_WORK_STATUSES.includes(work.status));

}
