// =========================
// Agent Handoff Manager(Step3)
// =========================
//
// Claude Code → Handoff State → Codex という流れを可能にする責務を
// 持つ。DB/Supabaseアクセス自体はAgentHandoffStore(types.ts)へ
// 委譲し、ここではHandoffの意味論(作成・現在の引き継ぎ状態の取得・
// 完了・再開)だけを扱う。
//
// DIパターン: core/tact-research/webResearch.tsのperformWebResearch()
// (searchImplをデフォルト引数で受け取る)と同じ理由で、storeを
// デフォルト引数として受け取る。本番呼び出し元はstoreを省略すれば
// Supabase実装が使われ、Unit Testはin-memory実装を明示的に渡せる。

import { randomUUID } from "crypto";

import {
  AgentHandoffStore,
  DevelopmentTask,
  HandoffGitState,
  HandoffState,
  VerificationStatus,
} from "./types";
import { createSupabaseAgentHandoffStore } from "./supabaseStore";

const defaultStore: AgentHandoffStore = createSupabaseAgentHandoffStore();

export interface CreateHandoffInput {

  taskId: string;

  fromAgent: string;

  toAgent: string;

  reason: string;

  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus;

  gitStatus: HandoffGitState;

  nextAction: string;

}

// Handoffを新規作成する(status: "pending")。この時点ではまだ
// DevelopmentTask.currentAgentを書き換えない
// ("引き継ぎ中"の状態であり、完了はcompleteHandoff()の責務)。
export async function createHandoff(
  input: CreateHandoffInput,
  store: AgentHandoffStore = defaultStore
): Promise<HandoffState> {

  const now = new Date().toISOString();

  const handoff: HandoffState = {

    handoffId: randomUUID(),

    taskId: input.taskId,

    fromAgent: input.fromAgent,

    toAgent: input.toAgent,

    reason: input.reason,

    completedWork: input.completedWork,

    pendingWork: input.pendingWork,

    verificationStatus: input.verificationStatus,

    gitStatus: input.gitStatus,

    nextAction: input.nextAction,

    status: "pending",

    createdAt: now,

  };

  await store.saveHandoff(handoff);

  return handoff;

}

// 指定Taskの最新(createdAt降順で先頭)のHandoffを返す。
// pending/completedを問わず「直近の引き継ぎ状態」を返す
// (statusで絞り込みたい場合は呼び出し元がフィルタする)。
export async function getCurrentHandoff(
  taskId: string,
  store: AgentHandoffStore = defaultStore
): Promise<HandoffState | undefined> {

  const handoffs = await store.listHandoffsForTask(taskId);

  return handoffs[0];

}

// Handoffを完了状態にし、対応するDevelopmentTask.currentAgentを
// toAgentへ更新する(ここが実際に「担当が切り替わる」瞬間)。
// DevelopmentTaskが見つからない場合は、Handoff自体は完了させるが
// currentAgentの更新はスキップする(存在しないTaskを捏造しない)。
export async function completeHandoff(
  handoffId: string,
  store: AgentHandoffStore = defaultStore
): Promise<HandoffState> {

  const handoff = await store.getHandoff(handoffId);

  if (!handoff) {
    throw new Error(`HandoffState not found: ${handoffId}`);
  }

  const now = new Date().toISOString();

  const completed: HandoffState = {
    ...handoff,
    status: "completed",
    completedAt: now,
  };

  await store.saveHandoff(completed);

  const task = await store.getTask(handoff.taskId);

  if (task) {

    const updatedTask: DevelopmentTask = {
      ...task,
      currentAgent: handoff.toAgent,
      status: task.status === "completed" ? task.status : "in_progress",
      updatedAt: now,
    };

    await store.saveTask(updatedTask);

  }

  return completed;

}

export interface ResumeFromHandoffResult {

  task: DevelopmentTask | undefined;

  handoff: HandoffState;

}

// 次のAgent(例: Codex)がHandoff Stateから再開地点を取得するための
// 読み取り専用の合成(状態を変更しない)。「何をやったのか/何を
// やっていないのか/何を確認済みなのか/どこから再開すればいいのか」
// (絶対条件、Step2)を1回の呼び出しで読める形にする。
export async function resumeFromHandoff(
  handoffId: string,
  store: AgentHandoffStore = defaultStore
): Promise<ResumeFromHandoffResult> {

  const handoff = await store.getHandoff(handoffId);

  if (!handoff) {
    throw new Error(`HandoffState not found: ${handoffId}`);
  }

  const task = await store.getTask(handoff.taskId);

  return { task, handoff };

}
