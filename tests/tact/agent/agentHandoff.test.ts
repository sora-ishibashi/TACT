// =========================
// TACT Agent Handoff Regression
// =========================
//
// 対象: core/tact-agent/*(DevelopmentTask/Agent/HandoffState/
// DevelopmentStateのDomain Model、agentRegistry.ts、taskManager.ts、
// handoffManager.ts、developmentState.ts、gitState.ts)。
//
// 環境制約(Phase66〜100と同一): 実DB書き込み・実LLM API・実Search
// API・実git write操作は一切行わない。すべてcreateInMemoryAgentHandoffStore()
// (プロセス内Mapのみ)を明示的に注入して検証する。tact_memoryは
// RLS Stage 0(anonキーから書き込み可能)であるため、npm testから
// 実Supabaseへ誤って書き込まないよう、Supabase実装(supabaseStore.ts)
// はここでは一切呼び出さない。captureGitState()のみ、ローカルgitの
// 読み取り専用コマンド(status/rev-parse)を実際に呼ぶ
// (書き込みは一切発生しない)。

import "dotenv/config";
import {
  clearAgentRegistry,
  registerAgent,
  getAgent,
  listAgents,
  updateAgentStatus,
  bootstrapDefaultAgents,
} from "../../../core/tact-agent/agentRegistry";
import { createDevelopmentTask, getCurrentAgentForTask } from "../../../core/tact-agent/taskManager";
import {
  createHandoff,
  getCurrentHandoff,
  completeHandoff,
  resumeFromHandoff,
} from "../../../core/tact-agent/handoffManager";
import { getDevelopmentState } from "../../../core/tact-agent/developmentState";
import { createInMemoryAgentHandoffStore } from "../../../core/tact-agent/inMemoryStore";
import { captureGitState } from "../../../core/tact-agent/gitState";
import type { AgentHandoffStore, HandoffGitState, VerificationStatus } from "../../../core/tact-agent/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeGitState(overrides: Partial<HandoffGitState> = {}): HandoffGitState {

  return {
    branch: "main",
    lastCommit: "abc1234567890abc1234567890abc1234567890",
    workingTreeStatus: "dirty",
    dirtyFileCount: 3,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };

}

function makeVerification(overrides: Partial<VerificationStatus> = {}): VerificationStatus {

  return {
    checks: { tsc: "passed", test: "passed", eslint: "passed", build: "not_run" },
    detail: "609 tests passed, 0 failed",
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Test1: Agent Registry
  // ==========================================================

  {

    clearAgentRegistry();

    registerAgent({
      agentId: "claude-code",
      name: "Claude Code",
      provider: "anthropic",
      capabilities: ["code_edit", "git", "test_execution"],
      status: "available",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    results.push(
      check(
        "[Test1-1] Agentを登録できる",
        getAgent("claude-code")?.name === "Claude Code"
      )
    );

    registerAgent({
      agentId: "codex",
      name: "Codex",
      provider: "openai",
      capabilities: ["code_edit"],
      status: "unavailable",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    results.push(
      check(
        "[Test1-2] 複数Agentを一覧取得できる(Provider名をDomain Logicにハードコードせず、" +
          "任意のagentIdを登録できることの確認)",
        listAgents().length === 2 &&
          listAgents().some((a) => a.agentId === "codex")
      )
    );

    const updated = updateAgentStatus("codex", "available");

    results.push(
      check(
        "[Test1-3] Agentのstatusを更新できる(Adapter実装が揃った場合にunavailable→availableへ" +
          "遷移させる想定)",
        updated?.status === "available"
      )
    );

    results.push(
      check(
        "[Test1-4] bootstrapDefaultAgents()がclaude-code/codexの2Agentを既定登録する" +
          "(冪等: 2回呼んでも重複登録しない)",
        (() => {
          clearAgentRegistry();
          bootstrapDefaultAgents();
          bootstrapDefaultAgents();
          const agents = listAgents();
          return (
            agents.length === 2 &&
            agents.some((a) => a.agentId === "claude-code" && a.status === "available") &&
            agents.some((a) => a.agentId === "codex" && a.status === "unavailable")
          );
        })(),
        `agents=${JSON.stringify(listAgents().map((a) => ({ id: a.agentId, status: a.status })))}`
      )
    );

  }

  // ==========================================================
  // Test2: DevelopmentTask作成・現在担当Agent取得
  // ==========================================================

  let store: AgentHandoffStore;
  let taskId: string;

  {

    store = createInMemoryAgentHandoffStore();

    const task = await createDevelopmentTask(
      {
        title: "Phase100後のTACT Core Agent Handoff基盤",
        description: "複数開発AgentがTaskを継続できる状態管理・引き継ぎ基盤を実装する",
        phase: "Phase101",
        priority: "high",
        currentAgent: "claude-code",
      },
      store
    );

    taskId = task.taskId;

    results.push(
      check(
        "[Test2-1] DevelopmentTaskを作成できる",
        task.title === "Phase100後のTACT Core Agent Handoff基盤" &&
          task.status === "pending" &&
          task.currentAgent === "claude-code"
      )
    );

    const currentAgent = await getCurrentAgentForTask(taskId, store);

    results.push(
      check(
        "[Test2-2] 現在担当Agentを取得できる",
        currentAgent === "claude-code"
      )
    );

  }

  // ==========================================================
  // Test3: Handoff作成・完了・再開(Claude Code → Codex)
  // ==========================================================

  let handoffId: string;

  {

    const handoff = await createHandoff(
      {
        taskId,
        fromAgent: "claude-code",
        toAgent: "codex",
        reason: "Claude Codeの週間利用制限に到達したため",
        completedWork: [
          "Core構造調査",
          "Domain Model設計",
          "Handoff Manager実装",
          "Unit Test",
        ],
        pendingWork: ["Codex Adapter確認"],
        verificationStatus: makeVerification(),
        gitStatus: makeGitState({ branch: "main", workingTreeStatus: "dirty", dirtyFileCount: 6 }),
        nextAction: "Codex Adapterの実装",
      },
      store
    );

    handoffId = handoff.handoffId;

    results.push(
      check(
        "[Test3-1] Handoffを作成できる(Claude CodeからCodexへのhandoffを表現できる、" +
          "最重要ユースケース)",
        handoff.fromAgent === "claude-code" &&
          handoff.toAgent === "codex" &&
          handoff.status === "pending"
      )
    );

    results.push(
      check(
        "[Test3-2] completedWork/pendingWorkを保持できる",
        handoff.completedWork.length === 4 &&
          handoff.completedWork.includes("Handoff Manager実装") &&
          handoff.pendingWork.length === 1 &&
          handoff.pendingWork[0] === "Codex Adapter確認"
      )
    );

    results.push(
      check(
        "[Test3-3] verificationStatusを保持できる(何を確認済みなのかを読める状態にする)",
        handoff.verificationStatus.checks.tsc === "passed" &&
          handoff.verificationStatus.checks.test === "passed" &&
          handoff.verificationStatus.checks.build === "not_run"
      )
    );

    results.push(
      check(
        "[Test3-4] Git stateを保持できる(branch/lastCommit/workingTreeStatus)",
        handoff.gitStatus.branch === "main" &&
          handoff.gitStatus.workingTreeStatus === "dirty" &&
          handoff.gitStatus.lastCommit.length > 0
      )
    );

    results.push(
      check(
        "[Test3-5] nextActionを保持できる(次のAgentがどこから再開すればいいか読める)",
        handoff.nextAction === "Codex Adapterの実装"
      )
    );

    const current = await getCurrentHandoff(taskId, store);

    results.push(
      check(
        "[Test3-6] getCurrentHandoff()で直近のHandoffを取得できる",
        current?.handoffId === handoffId
      )
    );

  }

  // ==========================================================
  // Test4: Codex側の再開(resumeFromHandoff)
  // ==========================================================

  {

    const resumed = await resumeFromHandoff(handoffId, store);

    results.push(
      check(
        "[Test4-1] Codex側がhandoff stateから再開地点を取得できる" +
          "(完了済み作業・未完了作業・検証状態・Git状態・次にやることを1回で取得できる)",
        resumed.handoff.handoffId === handoffId &&
          resumed.handoff.pendingWork.includes("Codex Adapter確認") &&
          resumed.task?.taskId === taskId
      )
    );

    results.push(
      check(
        "[Test4-2] resumeFromHandoff()は状態を変更しない(読み取り専用)" +
          "。完了前のHandoffはまだstatus='pending'のまま",
        resumed.handoff.status === "pending"
      )
    );

    const completed = await completeHandoff(handoffId, store);

    results.push(
      check(
        "[Test4-3] Handoffを完了できる(status='completed'、completedAtが設定される)",
        completed.status === "completed" && !!completed.completedAt
      )
    );

    const taskAfterHandoff = await getCurrentAgentForTask(taskId, store);

    results.push(
      check(
        "[Test4-4] Handoff完了により、DevelopmentTask.currentAgentがtoAgent(codex)へ" +
          "実際に切り替わる(担当交代が反映される)",
        taskAfterHandoff === "codex"
      )
    );

  }

  // ==========================================================
  // Test5: Development State(集約View、Step4)
  // ==========================================================

  {

    const state = await getDevelopmentState(taskId, store);

    results.push(
      check(
        "[Test5-1] Development Stateを1箇所から取得できる" +
          "(currentTask/currentPhase/currentAgent/completedWork/pendingWork/" +
          "verificationStatus/gitStatus/lastCommit/nextActionが揃う)",
        state.currentTask?.taskId === taskId &&
          state.currentPhase === "Phase101" &&
          state.currentAgent === "codex" &&
          state.completedWork.includes("Unit Test") &&
          state.pendingWork.includes("Codex Adapter確認") &&
          state.verificationStatus?.checks.tsc === "passed" &&
          state.gitStatus?.branch === "main" &&
          !!state.lastCommit &&
          state.nextAction === "Codex Adapterの実装"
      )
    );

    results.push(
      check(
        "[Test5-2] 存在しないTaskIdの場合、currentTaskはundefinedになり、架空のTaskを捏造しない",
        (await getDevelopmentState("does-not-exist", store)).currentTask === undefined
      )
    );

  }

  // ==========================================================
  // Test6: Git State Capture(core/codeAgent/gitProvider.tsの再利用確認)
  // ==========================================================

  {

    // repositoryPathには実際にこのリポジトリのルートを渡す
    // (読み取り専用のgit status/rev-parseのみが実行され、書き込みは
    // 発生しない)。ブランチ名・dirty状態は実行時の実際の状態に
    // 依存するため、値そのものではなく型・形の妥当性のみを確認する。
    const gitState = await captureGitState(process.cwd());

    results.push(
      check(
        "[Test6-1] captureGitState()がcore/codeAgent/gitProvider.tsのGitProvider.status()を" +
          "再利用して、branch/lastCommit/workingTreeStatusを取得できる(実装を重複させない)",
        typeof gitState.branch === "string" &&
          gitState.branch.length > 0 &&
          typeof gitState.lastCommit === "string" &&
          gitState.lastCommit.length > 0 &&
          (gitState.workingTreeStatus === "clean" || gitState.workingTreeStatus === "dirty"),
        `gitState=${JSON.stringify(gitState)}`
      )
    );

  }

  return summarize("agent-handoff (TACT Core Agent Handoff基盤)", results);

}
