// =========================
// Development Task Manager
// =========================
//
// DevelopmentTaskの作成・現在担当Agentの取得だけを扱う最小限の
// 責務(Handoffの意味論はhandoffManager.tsへ分離済み)。

import { randomUUID } from "crypto";

import {
  AgentHandoffStore,
  DevelopmentTask,
  DevelopmentTaskPriority,
} from "./types";
import { createSupabaseAgentHandoffStore } from "./supabaseStore";

const defaultStore: AgentHandoffStore = createSupabaseAgentHandoffStore();

export interface CreateDevelopmentTaskInput {

  title: string;

  description: string;

  phase?: string;

  priority?: DevelopmentTaskPriority;

  // 作成時点で担当Agentが決まっている場合のみ指定する。
  currentAgent?: string;

}

export async function createDevelopmentTask(
  input: CreateDevelopmentTaskInput,
  store: AgentHandoffStore = defaultStore
): Promise<DevelopmentTask> {

  const now = new Date().toISOString();

  const task: DevelopmentTask = {

    taskId: randomUUID(),

    title: input.title,

    description: input.description,

    phase: input.phase,

    status: "pending",

    priority: input.priority,

    currentAgent: input.currentAgent,

    startedAt: input.currentAgent ? now : undefined,

    createdAt: now,

    updatedAt: now,

  };

  await store.saveTask(task);

  return task;

}

export async function getCurrentAgentForTask(
  taskId: string,
  store: AgentHandoffStore = defaultStore
): Promise<string | undefined> {

  const task = await store.getTask(taskId);

  return task?.currentAgent;

}
