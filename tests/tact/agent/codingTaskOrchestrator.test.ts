// =========================
// TACT Agent — Agent Selection / Generic Handoff / Orchestrator入口
// (Phase111)
// =========================
//
// 対象: core/tact-agent/agentSelection.ts(新規)、
// core/tact-agent/agentHandoffRunner.ts(新規)、
// core/tact-agent/codingTaskRunner.ts(新規)。
//
// 環境制約: tests/tact/agent/codeAgentAdapterHandoff.test.tsと同じ方針
// (実DB書き込み・実LLM API・実Coding Agent実行(CLI起動)は一切行わない)。
// 実Adapter(ClaudeCodeAdapter/CodexAdapter)は使わず、
// CodingAgentAdapterインターフェースだけを満たす、完全に決定論的な
// Fake Adapterを注入して検証する(runCodingTask()のdeps.getAdapter経由)。
// DB書き込みはcreateInMemoryAgentHandoffStore()のみを使う。

import "dotenv/config";
import { selectCodingAgent } from "../../../core/tact-agent/agentSelection";
import { runCodingTask } from "../../../core/tact-agent/codingTaskRunner";
import { createDevelopmentTask, getCurrentAgentForTask } from "../../../core/tact-agent/taskManager";
import { createInMemoryAgentHandoffStore } from "../../../core/tact-agent/inMemoryStore";
import type { AgentCandidate, VerificationStatus } from "../../../core/tact-agent/types";
import type { CodeTask, CodeTaskExecutionResult, CodingAgentAdapter } from "../../../core/codeAgent/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeVerification(): VerificationStatus {
  return {
    checks: { tsc: "passed", test: "passed", eslint: "passed", build: "not_run" },
    detail: "664 tests passed, 0 failed",
  };
}

// 実CLIを一切起動しない、CodingAgentAdapterインターフェースだけを
// 満たすFake Adapter。呼び出し回数もカウントし、Orchestratorが
// 実際に何回execute()を呼んだかを検証できるようにする。
function makeFakeAdapter(config: {
  id: string;
  available: boolean;
  // 呼ばれるたびに順に返す実行結果(配列を使い切ったら最後の要素を繰り返す)。
  executeResults?: Array<Partial<CodeTaskExecutionResult> & { throwError?: string }>;
}): CodingAgentAdapter & {
  executeCallCount: number;
  executedInstructions: string[];
  receivedAttachments: CodeTask["attachments"][];
} {

  let callIndex = 0;

  return {
    id: config.id,
    executeCallCount: 0,
    executedInstructions: [],
    receivedAttachments: [],

    async isAvailable() {
      return { available: config.available, detail: `fake:${config.id}` };
    },

    async execute(task: CodeTask): Promise<CodeTaskExecutionResult> {

      this.executeCallCount += 1;
      this.executedInstructions.push(task.instruction);
      this.receivedAttachments.push(task.attachments);

      const results = config.executeResults ?? [{}];
      const spec = results[Math.min(callIndex, results.length - 1)];
      callIndex += 1;

      if (spec.throwError) {
        throw new Error(spec.throwError);
      }

      return {
        exitCode: spec.exitCode ?? 0,
        stdout: spec.stdout ?? "",
        stderr: spec.stderr ?? "",
        changedFiles: spec.changedFiles ?? [],
        durationMs: spec.durationMs ?? 1,
        timedOut: spec.timedOut ?? false,
      };

    },
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // selectCodingAgent(): 純粋関数の決定ルール
  // ==========================================================

  {

    const available = (agentId: string): AgentCandidate => ({
      agentId,
      availability: { available: true, detail: "" },
    });

    const unavailable = (agentId: string): AgentCandidate => ({
      agentId,
      availability: { available: false, detail: "down" },
    });

    results.push(
      check(
        "[TestM-1] ルール1: 現在Agentが利用可能かつ未試行なら、現在Agentを継続する",
        selectCodingAgent({
          candidates: [available("agent-x"), available("agent-y")],
          currentAgent: "agent-x",
        }).status === "selected" &&
          (selectCodingAgent({
            candidates: [available("agent-x"), available("agent-y")],
            currentAgent: "agent-x",
          }) as { agentId: string }).agentId === "agent-x"
      )
    );

    results.push(
      check(
        "[TestM-2] ルール2: 現在Agentが利用不可の場合、別の利用可能なAgentへ切り替える",
        (() => {
          const result = selectCodingAgent({
            candidates: [unavailable("agent-x"), available("agent-y")],
            currentAgent: "agent-x",
          });
          return result.status === "selected" && (result as { agentId: string }).agentId === "agent-y";
        })()
      )
    );

    results.push(
      check(
        "[TestM-3] ルール3: attemptedAgentsに含まれるAgentは、利用可能でも即再選択されない" +
          "(同じAgentへの即時再試行による無限ループ防止)",
        (() => {
          const result = selectCodingAgent({
            candidates: [available("agent-x"), available("agent-y")],
            currentAgent: "agent-x",
            attemptedAgents: ["agent-x"],
          });
          return result.status === "selected" && (result as { agentId: string }).agentId === "agent-y";
        })()
      )
    );

    results.push(
      check(
        "[TestM-4] ルール4: 利用可能なAgentが1つだけならそれを選ぶ",
        (() => {
          const result = selectCodingAgent({
            candidates: [unavailable("agent-x"), available("agent-y")],
          });
          return result.status === "selected" && (result as { agentId: string }).agentId === "agent-y";
        })()
      )
    );

    results.push(
      check(
        "[TestM-5] ルール5: 利用可能(かつ未試行)なAgentが0件なら、明確にunavailableを返す",
        selectCodingAgent({
          candidates: [unavailable("agent-x"), available("agent-y")],
          attemptedAgents: ["agent-y"],
        }).status === "unavailable"
      )
    );

    results.push(
      check(
        "[TestM-6] ルール6: Claude Code/Codexという固有名をハードコードしていない" +
          "(任意のagentId文字列で同じロジックが機能する)",
        selectCodingAgent({ candidates: [available("totally-custom-agent-name")] }).status === "selected"
      )
    );

  }

  // ==========================================================
  // runCodingTask(): Case A〜E(Fake Adapter注入、実CLI起動なし)
  // ==========================================================

  // Case A: 正常実行 → Handoffなし → completed
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase111 Case A", description: "正常実行", currentAgent: "agent-a" },
      store
    );

    const agentA = makeFakeAdapter({ id: "agent-a", available: true, executeResults: [{ exitCode: 0 }] });
    const agentB = makeFakeAdapter({ id: "agent-b", available: true });

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "Case A instruction",
        completedWork: [],
        pendingWork: [],
        verificationStatus: makeVerification(),
        nextAction: "n/a",
        candidateAgentIds: ["agent-a", "agent-b"],
      },
      {
        store,
        getAdapter: (id) => (id === "agent-a" ? agentA : agentB),
      }
    );

    results.push(
      check(
        "[TestN-A1] Case A: 正常実行はstatus='completed'、finalAgentが実行したAgentと一致する",
        result.status === "completed" && result.finalAgent === "agent-a"
      )
    );

    results.push(
      check(
        "[TestN-A2] Case A: Handoffは作成されない(attemptsに1件だけ、handoffが無い)",
        result.attempts.length === 1 && result.attempts[0].handoff === undefined
      )
    );

    results.push(
      check(
        "[TestN-A3] Case A: 別Agent(agent-b)のexecute()は一度も呼ばれない",
        agentB.executeCallCount === 0
      )
    );

  }

  // Case B: Agent failure → Handoff → 別Agent選択 → Resume → 次Agent実行
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase111 Case B", description: "failure→handoff→次Agent", currentAgent: "agent-a" },
      store
    );

    const agentA = makeFakeAdapter({ id: "agent-a", available: true, executeResults: [{ exitCode: 1 }] });
    const agentB = makeFakeAdapter({ id: "agent-b", available: true, executeResults: [{ exitCode: 0 }] });
    const attachmentContext = [{
      id: "att-1",
      kind: "image" as const,
      mimeType: "image/png",
      fileName: "reference.png",
      sizeBytes: 8,
      filePath: "C:\\temp\\tact-code-attachments\\task-attachment\\attachment-1.png",
    }];

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "Case B instruction (完了済み作業を含む元Instruction)",
        completedWork: ["前段の作業"],
        pendingWork: ["残りの作業"],
        verificationStatus: makeVerification(),
        nextAction: "残りの作業を進める",
        candidateAgentIds: ["agent-a", "agent-b"],
        attachments: attachmentContext,
      },
      {
        store,
        getAdapter: (id) => (id === "agent-a" ? agentA : agentB),
      }
    );

    results.push(
      check(
        "[TestN-B1] Case B: 最終的にstatus='completed'、finalAgentが切替後のAgent(agent-b)",
        result.status === "completed" && result.finalAgent === "agent-b"
      )
    );

    results.push(
      check(
        "[TestN-B2] Case B: 1回目の失敗Attemptに実際にHandoffが記録される" +
          "(fromAgent=agent-a, toAgent=agent-b)",
        result.attempts[0].handoff?.fromAgent === "agent-a" &&
          result.attempts[0].handoff?.toAgent === "agent-b"
      )
    );

    results.push(
      check(
        "[TestN-B3] Case B: DevelopmentTask.currentAgentが実際にagent-bへ切り替わる",
        (await getCurrentAgentForTask(task.taskId, store)) === "agent-b"
      )
    );

    results.push(
      check(
        "[TestN-B4] Case B: agent-bへ渡されたInstructionはHandoff Resumeから組み立て直され、" +
          "「完了済み(再実行しないこと)」に元のcompletedWorkの項目が含まれる" +
          "(completedWorkを次のAgentに再実行させない)",
        agentB.executedInstructions[0].includes("完了済み") &&
          agentB.executedInstructions[0].includes("前段の作業") &&
          agentB.executedInstructions[0].includes("残りの作業")
      )
    );

    results.push(
      check(
        "[TestN-B5] Case B: Attachment ContextはHandoff/Resume後も次Agentへ同じ値で渡る",
        agentA.receivedAttachments[0]?.[0]?.id === "att-1" &&
          agentB.receivedAttachments[0]?.[0]?.id === "att-1" &&
          agentB.receivedAttachments[0]?.[0]?.filePath === attachmentContext[0].filePath
      )
    );

  }

  // Case C: 最初のAgent unavailable → 別Agent選択 → 実行
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase111 Case C", description: "unavailable→切替", currentAgent: "agent-a" },
      store
    );

    const agentA = makeFakeAdapter({ id: "agent-a", available: false });
    const agentB = makeFakeAdapter({ id: "agent-b", available: true, executeResults: [{ exitCode: 0 }] });

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "Case C instruction",
        completedWork: [],
        pendingWork: ["最初から"],
        verificationStatus: makeVerification(),
        nextAction: "最初から実行する",
        candidateAgentIds: ["agent-a", "agent-b"],
      },
      {
        store,
        getAdapter: (id) => (id === "agent-a" ? agentA : agentB),
      }
    );

    results.push(
      check(
        "[TestN-C1] Case C: agent-aのexecute()は一度も呼ばれない(unavailableのため)",
        agentA.executeCallCount === 0
      )
    );

    results.push(
      check(
        "[TestN-C2] Case C: agent-bが選択・実行され、最終的にcompleted",
        result.status === "completed" && result.finalAgent === "agent-b"
      )
    );

  }

  // Case D: 両Agent unavailable → 明確に停止 → 無限ループなし
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase111 Case D", description: "両方unavailable", currentAgent: "agent-a" },
      store
    );

    const agentA = makeFakeAdapter({ id: "agent-a", available: false });
    const agentB = makeFakeAdapter({ id: "agent-b", available: false });

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "Case D instruction",
        completedWork: [],
        pendingWork: [],
        verificationStatus: makeVerification(),
        nextAction: "n/a",
        candidateAgentIds: ["agent-a", "agent-b"],
      },
      {
        store,
        getAdapter: (id) => (id === "agent-a" ? agentA : agentB),
      }
    );

    results.push(
      check(
        "[TestN-D1] Case D: status='unavailable'として明確に停止する",
        result.status === "unavailable"
      )
    );

    results.push(
      check(
        "[TestN-D2] Case D: どちらのAdapterのexecute()も一度も呼ばれない(無限ループなし)",
        agentA.executeCallCount === 0 && agentB.executeCallCount === 0
      )
    );

    results.push(
      check(
        "[TestN-D3] Case D: attemptsが空のまま(1回もAgentを実行せずに停止)",
        result.attempts.length === 0
      )
    );

  }

  // Case E: maxAttempts超過 → Handoff停止 → 明確なfailure result
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase111 Case E", description: "maxAttempts超過", currentAgent: "agent-a" },
      store
    );

    // 2つのAgentが交互に失敗し続ける状況を作り、maxAttemptsで
    // 必ず止まることを確認する(Claude→Codex→Claude→Codex...の
    // 無限ループにならないことの直接的な確認)。
    const agentA = makeFakeAdapter({ id: "agent-a", available: true, executeResults: [{ exitCode: 1 }] });
    const agentB = makeFakeAdapter({ id: "agent-b", available: true, executeResults: [{ exitCode: 1 }] });

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "Case E instruction",
        completedWork: [],
        pendingWork: ["終わらない作業"],
        verificationStatus: makeVerification(),
        nextAction: "終わらない作業を続ける",
        candidateAgentIds: ["agent-a", "agent-b"],
        maxAttempts: 3,
      },
      {
        store,
        getAdapter: (id) => (id === "agent-a" ? agentA : agentB),
      }
    );

    results.push(
      check(
        "[TestN-E1] Case E: maxAttempts(3)に到達し、status='max_attempts_exceeded'として" +
          "明確なfailure resultを返す",
        result.status === "max_attempts_exceeded"
      )
    );

    results.push(
      check(
        "[TestN-E2] Case E: 実際の試行回数がmaxAttemptsちょうど(3回)で打ち切られる" +
          "(無限ループにならない)",
        result.attempts.length === 3
      )
    );

    results.push(
      check(
        "[TestN-E3] Case E: 実際の試行順がagent-a→agent-b→agent-aのように往復する" +
          "(2Agent間のping-pongが可能で、maxAttemptsだけが止める役割を持つことの確認)",
        JSON.stringify(result.attempts.map((a) => a.agentId)) ===
          JSON.stringify(["agent-a", "agent-b", "agent-a"])
      )
    );

    results.push(
      check(
        "[TestN-E4] Case E: maxAttemptsに達した最後のAttemptにはHandoffが作成されない" +
          "(これ以上引き継がない)",
        result.attempts[result.attempts.length - 1].handoff === undefined
      )
    );

  }

  // Phase118: UIはこのcallbackをそのままstreamへ転送する。ここでは
  // Orchestratorが実際に通過した状態だけを順番に通知することを確認する。
  {

    const store = createInMemoryAgentHandoffStore();
    const task = await createDevelopmentTask(
      { title: "Phase118 execution log", description: "execution log", currentAgent: "agent-a" },
      store
    );
    const agent = makeFakeAdapter({
      id: "agent-a",
      available: true,
      executeResults: [{ exitCode: 0, changedFiles: ["components/Example.tsx"] }],
    });
    const messages: string[] = [];

    await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        instruction: "execution log test",
        completedWork: [],
        pendingWork: [],
        verificationStatus: makeVerification(),
        nextAction: "n/a",
        candidateAgentIds: ["agent-a"],
      },
      {
        store,
        getAdapter: () => agent,
        onExecutionLog: (event) => messages.push(event.message),
      }
    );

    results.push(
      check(
        "[Phase118] Execution Log is emitted from actual selection, execution, and completion states",
        JSON.stringify(messages) === JSON.stringify([
          "Agent selected: agent-a",
          "Coding agent started: agent-a",
          "agent-a success: 1 files changed",
          "Coding task completed",
        ])
      )
    );

  }

  return summarize("coding-task-orchestrator (Phase111)", results);

}
