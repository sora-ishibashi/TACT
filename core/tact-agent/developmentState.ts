// =========================
// Development State(Step4)
// =========================
//
// 「誰がどこまで進めたか」の正本を1箇所から取得できるようにする。
// DevelopmentTask/Handoffの実体はそれぞれのstoreへ永続化されたまま
// (types.tsのAgentHandoffStore)であり、ここでは2つを合成した
// 読み取り専用のViewを組み立てるだけで、3つ目の状態ストアを
// 新設しない。
//
// 責務の分離(絶対条件、Step4):
//   Execution Log(core/tact-core/execution/types.ts等) = 実行履歴
//   Development State(このファイル)                    = 現在地点
//   Handoff(handoffManager.ts)                          = Agent交代履歴

import { AgentHandoffStore, DevelopmentState } from "./types";
import { createSupabaseAgentHandoffStore } from "./supabaseStore";

const defaultStore: AgentHandoffStore = createSupabaseAgentHandoffStore();

export async function getDevelopmentState(
  taskId: string,
  store: AgentHandoffStore = defaultStore
): Promise<DevelopmentState> {

  const task = await store.getTask(taskId);

  const handoffs = await store.listHandoffsForTask(taskId);

  const latestHandoff = handoffs[0];

  return {

    currentTask: task,

    currentPhase: task?.phase,

    currentAgent: task?.currentAgent,

    completedWork: latestHandoff?.completedWork ?? [],

    pendingWork: latestHandoff?.pendingWork ?? [],

    verificationStatus: latestHandoff?.verificationStatus,

    gitStatus: latestHandoff?.gitStatus,

    lastCommit: latestHandoff?.gitStatus.lastCommit,

    nextAction: latestHandoff?.nextAction,

    latestHandoff,

  };

}
