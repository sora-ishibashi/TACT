// =========================
// In-Memory AgentHandoffStore
// =========================
//
// プロセス内Mapのみで完結する、AgentHandoffStoreの純粋な実装。
// Unit Testで実Supabaseに触れずにHandoffManager/DevelopmentStateの
// ロジックを検証するために使う(core/tact-core/mockCoreCapability.ts
// と同じ位置づけ)。

import {
  AgentHandoffStore,
  DevelopmentTask,
  HandoffState,
} from "./types";

export function createInMemoryAgentHandoffStore(): AgentHandoffStore {

  const tasks = new Map<string, DevelopmentTask>();
  const handoffs = new Map<string, HandoffState>();

  return {

    id: "in-memory",

    async saveTask(task: DevelopmentTask): Promise<void> {
      tasks.set(task.taskId, task);
    },

    async getTask(taskId: string): Promise<DevelopmentTask | undefined> {
      return tasks.get(taskId);
    },

    async listTasks(limit: number = 20): Promise<DevelopmentTask[]> {

      return Array.from(tasks.values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);

    },

    async saveHandoff(handoff: HandoffState): Promise<void> {
      handoffs.set(handoff.handoffId, handoff);
    },

    async getHandoff(handoffId: string): Promise<HandoffState | undefined> {
      return handoffs.get(handoffId);
    },

    async listHandoffsForTask(taskId: string): Promise<HandoffState[]> {

      return Array.from(handoffs.values())
        .filter((h) => h.taskId === taskId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    },

  };

}
