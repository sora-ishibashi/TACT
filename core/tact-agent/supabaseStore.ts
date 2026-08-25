// =========================
// Supabase-backed AgentHandoffStore
// =========================
//
// DB設計方針(Step10): 新規テーブルは作らない。
//
// core/codeAgent/store.ts(STEP142-D)と同じ理由で、既存の
// tact_memoryテーブル(supabase/migrations/
// 20260821000000_create_brain_memory_tables.sql)を再利用する。
// type列のCHECK制約は既に 'task' を許可しており、core/codeAgent/
// store.tsのCodeTaskも同じ 'task' 値で永続化している。
//
// CodeTask(1回のCoding Agent実行)とDevelopmentTask/HandoffState
// (Phase単位の長命な開発作業とAgent交代履歴)は概念が異なるため、
// 同じtype:'task'バケツ内で取り違えないよう、content内に
// recordKindという判別フィールドを追加する(DB Schema自体は
// 変更しない、JSONBの中身だけで区別する)。
//
// RLS: tact_memoryは既存のStage 0(anonキーからの全操作許可、
// supabase/migrations/20260821000000...のコメント参照)のまま
// 変更しない(既存Stage/RLS設計を尊重する、Step10絶対条件)。

import { supabase } from "../database/supabase";
import {
  AgentHandoffStore,
  DevelopmentTask,
  HandoffState,
} from "./types";

const MEMORY_TYPE = "task";

type DevelopmentTaskRecord = DevelopmentTask & { recordKind: "development_task" };
type HandoffRecord = HandoffState & { recordKind: "agent_handoff" };

// DB未接続時のフォールバック(core/codeAgent/store.tsと同じ、
// プロセス内キャッシュ + DB永続化の二層構成)。
const taskCache: Map<string, DevelopmentTask> = new Map();
const handoffCache: Map<string, HandoffState> = new Map();

export function createSupabaseAgentHandoffStore(): AgentHandoffStore {

  return {

    id: "supabase-tact-memory",

    async saveTask(task: DevelopmentTask): Promise<void> {

      taskCache.set(task.taskId, task);

      const record: DevelopmentTaskRecord = { ...task, recordKind: "development_task" };

      try {

        const { error } = await supabase
          .from("tact_memory")
          .upsert(
            {
              id: task.taskId,
              type: MEMORY_TYPE,
              target_agent: task.currentAgent ?? null,
              content: record,
              importance: 5,
              confidence: "medium",
              updated_at: task.updatedAt,
            },
            { onConflict: "id" }
          );

        if (error) throw error;

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to persist DevelopmentTask to DB. " +
          "Falling back to in-process cache only.",
          error instanceof Error ? error.message : error
        );

      }

    },

    async getTask(taskId: string): Promise<DevelopmentTask | undefined> {

      try {

        const { data, error } = await supabase
          .from("tact_memory")
          .select("content")
          .eq("id", taskId)
          .eq("type", MEMORY_TYPE)
          .eq("content->>recordKind", "development_task")
          .maybeSingle();

        if (error) throw error;

        if (data?.content) {
          return data.content as DevelopmentTask;
        }

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to load DevelopmentTask from DB. " +
          "Falling back to in-process cache.",
          error instanceof Error ? error.message : error
        );

      }

      return taskCache.get(taskId);

    },

    async listTasks(limit: number = 20): Promise<DevelopmentTask[]> {

      try {

        const { data, error } = await supabase
          .from("tact_memory")
          .select("content, updated_at")
          .eq("type", MEMORY_TYPE)
          .eq("content->>recordKind", "development_task")
          .order("updated_at", { ascending: false })
          .limit(limit);

        if (error) throw error;

        if (data) {
          return data.map((row) => row.content as DevelopmentTask);
        }

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to list DevelopmentTasks from DB. " +
          "Falling back to in-process cache.",
          error instanceof Error ? error.message : error
        );

      }

      return Array.from(taskCache.values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);

    },

    async saveHandoff(handoff: HandoffState): Promise<void> {

      handoffCache.set(handoff.handoffId, handoff);

      const record: HandoffRecord = { ...handoff, recordKind: "agent_handoff" };

      try {

        const { error } = await supabase
          .from("tact_memory")
          .upsert(
            {
              id: handoff.handoffId,
              type: MEMORY_TYPE,
              target_agent: handoff.toAgent,
              content: record,
              importance: 5,
              confidence: "medium",
              updated_at: handoff.completedAt ?? handoff.createdAt,
            },
            { onConflict: "id" }
          );

        if (error) throw error;

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to persist HandoffState to DB. " +
          "Falling back to in-process cache only.",
          error instanceof Error ? error.message : error
        );

      }

    },

    async getHandoff(handoffId: string): Promise<HandoffState | undefined> {

      try {

        const { data, error } = await supabase
          .from("tact_memory")
          .select("content")
          .eq("id", handoffId)
          .eq("type", MEMORY_TYPE)
          .eq("content->>recordKind", "agent_handoff")
          .maybeSingle();

        if (error) throw error;

        if (data?.content) {
          return data.content as HandoffState;
        }

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to load HandoffState from DB. " +
          "Falling back to in-process cache.",
          error instanceof Error ? error.message : error
        );

      }

      return handoffCache.get(handoffId);

    },

    async listHandoffsForTask(taskId: string): Promise<HandoffState[]> {

      try {

        const { data, error } = await supabase
          .from("tact_memory")
          .select("content")
          .eq("type", MEMORY_TYPE)
          .eq("content->>recordKind", "agent_handoff")
          .eq("content->>taskId", taskId)
          .order("updated_at", { ascending: false });

        if (error) throw error;

        if (data) {
          return data.map((row) => row.content as HandoffState);
        }

      } catch (error) {

        console.warn(
          "[TACT Agent] Failed to list HandoffStates from DB. " +
          "Falling back to in-process cache.",
          error instanceof Error ? error.message : error
        );

      }

      return Array.from(handoffCache.values())
        .filter((h) => h.taskId === taskId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    },

  };

}
