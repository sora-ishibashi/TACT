// =========================
// TACT Agent — Coding Agent Adapter接続 / Handoff Trigger Regression
// (Phase104)
// =========================
//
// 対象: core/codeAgent/adapterRegistry.ts(Codex拡張点の実接続)、
// core/codeAgent/codexAdapter.ts(新規)、core/tact-agent/handoffTrigger.ts
// (新規)、core/tact-agent/claudeToCodexHandoff.ts(新規)、
// core/tact-agent/codexResume.ts(新規)。
//
// tests/tact/agent/agentHandoff.test.tsが既にDomain Model
// (Agent Registry/DevelopmentTask/HandoffState/DevelopmentState)を
// 決定論的に検証済みのため、ここでは重複させず、Phase104で新規に
// 追加した「実Adapter境界への接続」「継続不能判定(Handoff Trigger)」
// 「Claude→Codex Handoffの一連手順」「Codex側の再開合成」だけを
// 対象にする。
//
// 環境制約: 実DB書き込み・実LLM API・実Coding Agent実行(CLI起動)は
// 一切行わない。すべてcreateInMemoryAgentHandoffStore()を明示的に
// 注入する。getCodingAgentAdapter("claude-code").isAvailable()は
// 実際に`claude --version`を子プロセスとして起動する既存実装のため、
// ここでは呼ばない(Reality Test側でのみ、必要最小限を実行する)。

import "dotenv/config";
import { getCodingAgentAdapter, CodingAgentProviderId } from "../../../core/codeAgent/adapterRegistry";
import { computeChangedFiles } from "../../../core/codeAgent/claudeCodeAdapter";
import {
  classifyAgentContinuation,
  evaluateHandoffTrigger,
} from "../../../core/tact-agent/handoffTrigger";
import { runClaudeToCodexHandoff } from "../../../core/tact-agent/claudeToCodexHandoff";
import {
  resumeLatestHandoffForTask,
  buildCodexResumeInstruction,
} from "../../../core/tact-agent/codexResume";
import { createDevelopmentTask, getCurrentAgentForTask } from "../../../core/tact-agent/taskManager";
import { createInMemoryAgentHandoffStore } from "../../../core/tact-agent/inMemoryStore";
import type { VerificationStatus } from "../../../core/tact-agent/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeVerification(overrides: Partial<VerificationStatus> = {}): VerificationStatus {

  return {
    checks: { tsc: "passed", test: "passed", eslint: "passed", build: "not_run" },
    detail: "591 tests passed, 0 failed",
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  {

    const changedFiles = computeChangedFiles(
      new Set(["already-dirty.ts"]),
      new Set(["already-dirty.ts", "newly-changed.ts"])
    );

    results.push(
      check(
        "[Phase117] 実行前からdirtyだったファイルは今回のAttemptのchangedFilesへ誤って含めず、" +
          "実行後に新たに観測されたファイルのみをReportへ渡す",
        changedFiles.length === 1 && changedFiles[0] === "newly-changed.ts"
      )
    );

  }

  // ==========================================================
  // Test B / C / J: Adapter RegistryからClaude Code / Codex両方の
  // Adapterを取得できる(core/codeAgent/adapterRegistry.ts、Phase104で
  // Codexケースを追加)
  // ==========================================================

  {

    const claudeCode = getCodingAgentAdapter("claude-code");

    results.push(
      check(
        "[TestB] Claude Code Adapterを取得できる(既存ClaudeCodeAdapter、無変更)",
        claudeCode.id === "claude-code" &&
          typeof claudeCode.isAvailable === "function" &&
          typeof claudeCode.execute === "function"
      )
    );

    const codex = getCodingAgentAdapter("codex");

    results.push(
      check(
        "[TestC-1] Codex Adapterを取得できる(Phase104で新規追加)",
        codex.id === "codex" &&
          typeof codex.isAvailable === "function" &&
          typeof codex.execute === "function"
      )
    );

    // Phase110: CodexAdapter.isAvailable()は、ClaudeCodeAdapterと同様に
    // 実際に`codex.cmd login status`を子プロセスとして起動する実装に
    // なった(Phase104までのような常時false固定ではなくなった)。
    // このFileの環境制約(冒頭コメント: 実Coding Agent実行(CLI起動)は
    // 一切行わない。getCodingAgentAdapter("claude-code").isAvailable()も
    // 同じ理由でここでは呼んでいない)に合わせ、CodexAdapter.isAvailable()も
    // ここでは呼ばない(実際にavailable:trueになること・実行できることの
    // 確認はPhase110 Reality Test側でのみ行う)。
    //
    // ここでは代わりに、実際のCodex CLI起動を一切発生させずに検証できる
    // 「二重の安全弁」(未承認Taskは拒否する)だけを確認する。
    // CodexAdapter.execute()は、status!=="approved"のTaskに対しては
    // 実CLIをspawnする前にguardで例外を投げる実装のため、この検証は
    // Codexのインストール状態に関わらず決定論的に安全に実行できる。

    let executeThrewForUnapprovedTask = false;

    try {
      await codex.execute({
        id: "dummy",
        proposalId: "dummy",
        status: "draft",
        executionPolicy: "human_approval_required",
        repositoryPath: ".",
        instruction: "test",
        targetFiles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      executeThrewForUnapprovedTask = true;
    }

    results.push(
      check(
        "[TestC-2] Codex Adapter.execute()は未承認Task(status!=='approved')に対しては、" +
          "実際のCodex CLIを起動する前に例外を投げる(二重の安全弁、ClaudeCodeAdapterと" +
          "同じ設計。Phase110: 実CLI接続後もこのガードが最初に評価されることを、" +
          "Codexのインストール状態に依存せず確認する)",
        executeThrewForUnapprovedTask
      )
    );

    results.push(
      check(
        "[TestJ] Claude Code / Codex両方のAdapterが同じgetCodingAgentAdapter()経由で、" +
          "互いに独立したidを持つ状態で取得できる",
        claudeCode.id !== codex.id
      )
    );

    const providerIds: CodingAgentProviderId[] = ["claude-code", "codex"];

    results.push(
      check(
        "[TestJ-2] CodingAgentProviderId型がclaude-code/codexの両方を許容する" +
          "(exhaustive checkによりAdapter実装漏れがあればtsc段階で検出される設計を維持)",
        providerIds.length === 2
      )
    );

  }

  // ==========================================================
  // Test D / E: Handoff Trigger — 正常終了ではHandoffせず、
  // 継続不能(unavailable/failure/interrupted)ではHandoffする
  // ==========================================================

  {

    const successOutcome = evaluateHandoffTrigger({
      executionResult: { exitCode: 0, timedOut: false },
    });

    results.push(
      check(
        "[TestD] Claude Codeの正常終了(exitCode=0)ではHandoffしない" +
          "(status='success'、shouldHandoff=false)",
        successOutcome.status === "success" && successOutcome.shouldHandoff === false
      )
    );

    const unavailable = classifyAgentContinuation({
      availability: { available: false, detail: "claude command not found" },
    });

    const failure = classifyAgentContinuation({
      executionResult: { exitCode: 1, timedOut: false },
    });

    const interrupted = classifyAgentContinuation({
      executionResult: { exitCode: null, timedOut: true },
    });

    results.push(
      check(
        "[TestE-1] Claude Code Adapterが利用不可(isAvailable=false)の場合、'unavailable'として" +
          "継続不能と判定される",
        unavailable === "unavailable"
      )
    );

    results.push(
      check(
        "[TestE-2] 実行がエラー終了(exitCode!=0)の場合、'failure'として継続不能と判定される" +
          "(unavailableとは異なるstatusとして区別される、単純なCoding Errorとの混同防止)",
        failure === "failure" && failure !== unavailable
      )
    );

    results.push(
      check(
        "[TestE-3] 実行がtimeout(timedOut=true)の場合、'interrupted'として継続不能と判定される" +
          "(failure/unavailableとは異なるstatusとして区別される)",
        interrupted === "interrupted" && interrupted !== failure && interrupted !== unavailable
      )
    );

    results.push(
      check(
        "[TestE-4] unavailable/failure/interruptedいずれもshouldHandoff=trueになる",
        evaluateHandoffTrigger({ availability: { available: false, detail: "x" } }).shouldHandoff === true &&
          evaluateHandoffTrigger({ executionResult: { exitCode: 1, timedOut: false } }).shouldHandoff === true &&
          evaluateHandoffTrigger({ executionResult: { exitCode: null, timedOut: true } }).shouldHandoff === true
      )
    );

  }

  // ==========================================================
  // Test F / I: runClaudeToCodexHandoff() — 継続不能と判定された
  // 場合のみHandoffが作成され、currentAgentがcodexへ切り替わる。
  // completedWorkはそのまま保持され、再実行対象として扱われない。
  // ==========================================================

  {

    const store = createInMemoryAgentHandoffStore();

    const task = await createDevelopmentTask(
      {
        title: "Phase104 Handoff Trigger統合テスト",
        description: "Claude Code Adapter接続とHandoff経路のテスト用Task",
        phase: "Phase104",
        currentAgent: "claude-code",
      },
      store
    );

    // 正常終了の場合: Handoffが作成されない、currentAgentはclaude-codeのまま。
    const successResult = await runClaudeToCodexHandoff(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        outcome: { executionResult: { exitCode: 0, timedOut: false } },
        completedWork: ["すべて完了"],
        pendingWork: [],
        verificationStatus: makeVerification(),
        nextAction: "なし",
      },
      store
    );

    results.push(
      check(
        "[TestD-2] 正常終了時、runClaudeToCodexHandoff()はHandoffを作成しない(triggered=false)",
        successResult.triggered === false && successResult.handoff === undefined
      )
    );

    results.push(
      check(
        "[TestD-3] 正常終了時、currentAgentはclaude-codeのまま変化しない",
        (await getCurrentAgentForTask(task.taskId, store)) === "claude-code"
      )
    );

    // 継続不能(unavailable)の場合: Handoffが作成され、currentAgentがcodexへ切り替わる。
    const handoffResult = await runClaudeToCodexHandoff(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        outcome: { availability: { available: false, detail: "claude command not found" } },
        completedWork: ["Adapter Registry調査", "Handoff Trigger実装", "Unit Test"],
        pendingWork: ["Codex実Adapter接続", "Reality Test"],
        verificationStatus: makeVerification(),
        nextAction: "Codex実Adapter接続を進める",
      },
      store
    );

    results.push(
      check(
        "[TestE-5] 継続不能(unavailable)と判定された場合、runClaudeToCodexHandoff()が" +
          "実際にHandoffを作成する(triggered=true)",
        handoffResult.triggered === true && !!handoffResult.handoff
      )
    );

    results.push(
      check(
        "[TestE-6] 作成されたHandoffのreasonが、unavailableであることを明確に示す" +
          "(単純なCoding Errorの文言と混同しない)",
        handoffResult.reason.includes("isAvailable") || handoffResult.reason.includes("実行不可")
      )
    );

    results.push(
      check(
        "[TestF] Handoff完了により、DevelopmentTask.currentAgentが実際にcodexへ切り替わる",
        (await getCurrentAgentForTask(task.taskId, store)) === "codex"
      )
    );

    results.push(
      check(
        "[TestI-1] runClaudeToCodexHandoff()へ渡したcompletedWorkが、そのままHandoffへ" +
          "保持される(推測・再構成しない)",
        handoffResult.handoff?.completedWork.length === 3 &&
          handoffResult.handoff?.completedWork.includes("Handoff Trigger実装")
      )
    );

    results.push(
      check(
        "[TestI-2] pendingWorkとcompletedWorkが混同されない" +
          "(completedWorkの項目がpendingWorkに紛れ込まない)",
        !handoffResult.handoff?.pendingWork.includes("Adapter Registry調査") &&
          handoffResult.handoff?.pendingWork.includes("Codex実Adapter接続") === true
      )
    );

    // ==========================================================
    // Test G / H: Codex側の再開(resumeLatestHandoffForTask +
    // buildCodexResumeInstruction)
    // ==========================================================

    const resumed = await resumeLatestHandoffForTask(task.taskId, store);

    results.push(
      check(
        "[TestG-1] Codex側がtaskId起点で、completedWork/pendingWork/verificationStatus/" +
          "gitStatus/nextActionをすべて復元できる",
        resumed !== undefined &&
          resumed.handoff.completedWork.length === 3 &&
          resumed.handoff.pendingWork.includes("Reality Test") &&
          resumed.handoff.verificationStatus.checks.tsc === "passed" &&
          !!resumed.handoff.gitStatus.branch &&
          resumed.handoff.nextAction === "Codex実Adapter接続を進める",
        `resumed=${JSON.stringify(resumed?.handoff)}`
      )
    );

    const resumedAgain = await resumeLatestHandoffForTask(task.taskId, store);

    results.push(
      check(
        "[TestH] Codexの再開地点が一意に決定できる(同じtaskIdに対し常に同じ最新Handoffが" +
          "返る、複数回呼んでも結果がぶれない)",
        resumed?.handoff.handoffId === resumedAgain?.handoff.handoffId
      )
    );

    results.push(
      check(
        "[TestG-2] Task自体が存在しない/HandoffがまだないtaskIdに対してはundefinedを返す" +
          "(架空のHandoffを捏造しない)",
        (await resumeLatestHandoffForTask("does-not-exist", store)) === undefined
      )
    );

    if (resumed) {

      const instruction = buildCodexResumeInstruction(resumed);

      results.push(
        check(
          "[TestI-3] Codexへ渡すInstructionにpendingWork/nextActionが含まれ、" +
            "completedWorkの項目は「完了済み(再実行しないこと)」として明示的に区別される" +
            "(completedWorkを再実行対象として扱わない)",
          instruction.includes("Codex実Adapter接続") &&
            instruction.includes("Codex実Adapter接続を進める") &&
            instruction.includes("完了済み") &&
            instruction.includes("Handoff Trigger実装")
        )
      );

      results.push(
        check(
          "[TestI-4] Instruction生成はLLM呼び出しを行わない決定論的な文字列組み立てのみ" +
            "(同じHandoffから常に同じInstructionが得られる)",
          instruction === buildCodexResumeInstruction(resumed)
        )
      );

    }

  }

  // ==========================================================
  // Test K / L(Phase109): runClaudeToCodexHandoff()のfailure/
  // interrupted経路が、unavailableと同様にend-to-endでHandoffを
  // 作成しcurrentAgentを切り替えることの確認。
  //
  // 既存TestE-2/E-3はclassifyAgentContinuation()単体でfailure/
  // interruptedを判定できることのみを確認しており、
  // runClaudeToCodexHandoff() → createHandoff() → completeHandoff() →
  // currentAgent切り替えまでの一連の経路はunavailable(TestE-5/F)でしか
  // 確認していなかった。Phase109 Reality Testの対象(実Claude Code
  // Adapterのexit code!=0によるfailure)をUnit Testでも決定論的に
  // 裏付ける。
  // ==========================================================

  {

    const store = createInMemoryAgentHandoffStore();

    const task = await createDevelopmentTask(
      {
        title: "Phase109 Failure Handoff統合テスト",
        description: "Claude Code実行がexitCode!=0で終了した場合のHandoff経路確認用Task",
        phase: "Phase109",
        currentAgent: "claude-code",
      },
      store
    );

    const failureResult = await runClaudeToCodexHandoff(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        outcome: { executionResult: { exitCode: 1, timedOut: false } },
        completedWork: ["環境確認"],
        pendingWork: ["原因調査", "再実行"],
        verificationStatus: makeVerification({ checks: { tsc: "passed", test: "not_run", eslint: "not_run", build: "not_run" } }),
        nextAction: "実行ログを確認して原因調査を行う",
      },
      store
    );

    results.push(
      check(
        "[TestK-1] 実行がエラー終了(exitCode!=0)の場合も、runClaudeToCodexHandoff()が" +
          "実際にHandoffを作成する(triggered=true、unavailableだけでなくfailureでも" +
          "end-to-endで機能する)",
        failureResult.triggered === true && !!failureResult.handoff
      )
    );

    results.push(
      check(
        "[TestK-2] failure経路で作成されたHandoffのreasonが、単純なCoding Errorであることを" +
          "示す(unavailableの文言と混同しない)",
        failureResult.reason.includes("エラー終了") &&
          !failureResult.reason.includes("isAvailable")
      )
    );

    results.push(
      check(
        "[TestK-3] failure経路でも、Handoff完了によりDevelopmentTask.currentAgentが" +
          "実際にcodexへ切り替わる",
        (await getCurrentAgentForTask(task.taskId, store)) === "codex"
      )
    );

  }

  {

    const store = createInMemoryAgentHandoffStore();

    const task = await createDevelopmentTask(
      {
        title: "Phase109 Interrupted Handoff統合テスト",
        description: "Claude Code実行がtimeoutで終了した場合のHandoff経路確認用Task",
        phase: "Phase109",
        currentAgent: "claude-code",
      },
      store
    );

    const interruptedResult = await runClaudeToCodexHandoff(
      {
        taskId: task.taskId,
        repositoryPath: process.cwd(),
        outcome: { executionResult: { exitCode: null, timedOut: true } },
        completedWork: [],
        pendingWork: ["timeoutしたTaskの再実行"],
        verificationStatus: makeVerification({ checks: {} }),
        nextAction: "timeoutの原因を確認し、必要ならtimeoutMsを見直して再実行する",
      },
      store
    );

    results.push(
      check(
        "[TestL-1] 実行がtimeout(timedOut=true)の場合も、runClaudeToCodexHandoff()が" +
          "実際にHandoffを作成する(triggered=true)",
        interruptedResult.triggered === true && !!interruptedResult.handoff
      )
    );

    results.push(
      check(
        "[TestL-2] interrupted経路で作成されたHandoffのreasonが、timeout/中断であることを示す",
        interruptedResult.reason.includes("timeout") || interruptedResult.reason.includes("中断")
      )
    );

    results.push(
      check(
        "[TestL-3] interrupted経路でも、Handoff完了によりDevelopmentTask.currentAgentが" +
          "実際にcodexへ切り替わる",
        (await getCurrentAgentForTask(task.taskId, store)) === "codex"
      )
    );

  }

  // ==========================================================
  // Test A: DevelopmentTask(currentAgent=claude-code)の作成
  // (既存tests/tact/agent/agentHandoff.test.tsのTest2-1で決定論的に
  // 検証済みのため、ここでは重複させず参照のみ。Adapter接続の文脈で
  // 改めて1件だけ確認する)
  // ==========================================================

  {

    const store = createInMemoryAgentHandoffStore();

    const task = await createDevelopmentTask(
      {
        title: "Phase104確認用Task",
        description: "Adapter接続確認用",
        currentAgent: "claude-code",
      },
      store
    );

    results.push(
      check(
        "[TestA] currentAgent='claude-code'のDevelopmentTaskを作成できる(Primary Agent設定)",
        task.currentAgent === "claude-code" && task.status === "pending"
      )
    );

  }

  return summarize("code-agent-adapter-handoff (Phase 104)", results);

}
