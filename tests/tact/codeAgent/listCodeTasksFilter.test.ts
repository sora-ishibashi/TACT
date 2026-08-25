// =========================
// listCodeTasks() Non-CodeTask Record Filtering Regression (Phase 103)
// =========================
//
// 対象: core/codeAgent/store.tsのselectCodeTasksFromRows()
// (listCodeTasks()の中核ロジックを切り出した純粋関数)。
//
// Root Cause(Phase102 Reality Testで実際に確認): core/tact-agent/
// (Phase101)がtact_memoryの同じtype="task"バケツを
// content.recordKind('development_task'|'agent_handoff')で判別して
// 再利用しているため、listCodeTasks()(type="task"のみでフィルタ)が
// DevelopmentTask/HandoffStateまで返してしまうことが実DBで確認された。
//
// 環境制約(Phase66〜102と同一): 実DB接続・実LLM API・実Search APIは
// 一切呼ばない。selectCodeTasksFromRows()はDB往復から独立した純粋
// 関数であり、Supabaseへの接続なしに検証できる。

import "dotenv/config";
import { selectCodeTasksFromRows } from "../../../core/codeAgent/store";
import type { CodeTask } from "../../../core/codeAgent/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeCodeTask(overrides: Partial<CodeTask> & { id: string }): CodeTask {

  return {
    proposalId: "proposal-1",
    status: "ready_for_approval",
    executionPolicy: "human_approval_required",
    repositoryPath: "/repo",
    instruction: "dummy instruction",
    targetFiles: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };

}

function makeDevelopmentTaskRow(id: string) {

  return {
    content: {
      recordKind: "development_task",
      taskId: id,
      title: "dummy development task",
      description: "dummy",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

}

function makeHandoffRow(id: string) {

  return {
    content: {
      recordKind: "agent_handoff",
      handoffId: id,
      taskId: "some-task",
      fromAgent: "claude-code",
      toAgent: "codex",
      reason: "dummy",
      completedWork: [],
      pendingWork: [],
      verificationStatus: { checks: {} },
      gitStatus: { branch: "main", lastCommit: "abc", workingTreeStatus: "clean", capturedAt: new Date().toISOString() },
      nextAction: "dummy",
      status: "pending",
      createdAt: new Date().toISOString(),
    },
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Case A: CodeTaskのみ存在する場合 -> CodeTaskのみ
  // ==========================================================

  {

    const rows = [
      { content: makeCodeTask({ id: "ct-1" }) },
      { content: makeCodeTask({ id: "ct-2" }) },
    ];

    const result = selectCodeTasksFromRows(rows, 20);

    results.push(
      check(
        "[CaseA] CodeTaskのみ存在する場合、listCodeTasks()相当のロジックはCodeTaskのみを返す",
        result.length === 2 && result.every((t) => t.id === "ct-1" || t.id === "ct-2"),
        `result=${JSON.stringify(result.map((t) => t.id))}`
      )
    );

  }

  // ==========================================================
  // Case B: CodeTask + DevelopmentTaskが存在する場合 -> CodeTaskのみ
  // ==========================================================

  {

    const rows = [
      { content: makeCodeTask({ id: "ct-1" }) },
      makeDevelopmentTaskRow("dev-1"),
    ];

    const result = selectCodeTasksFromRows(rows, 20);

    results.push(
      check(
        "[CaseB] CodeTask + DevelopmentTaskが混在する場合、DevelopmentTaskは除外されCodeTaskのみ残る" +
          "(Phase102で実DB上で確認された混入の直接的な修正確認)",
        result.length === 1 && result[0].id === "ct-1",
        `result=${JSON.stringify(result.map((t) => t.id))}`
      )
    );

  }

  // ==========================================================
  // Case C: CodeTask + HandoffStateが存在する場合 -> CodeTaskのみ
  // ==========================================================

  {

    const rows = [
      { content: makeCodeTask({ id: "ct-1" }) },
      makeHandoffRow("handoff-1"),
    ];

    const result = selectCodeTasksFromRows(rows, 20);

    results.push(
      check(
        "[CaseC] CodeTask + HandoffStateが混在する場合、HandoffStateは除外されCodeTaskのみ残る",
        result.length === 1 && result[0].id === "ct-1",
        `result=${JSON.stringify(result.map((t) => t.id))}`
      )
    );

  }

  // ==========================================================
  // Case D: DevelopmentTask + HandoffStateしか存在しない場合 -> []
  // ==========================================================

  {

    const rows = [
      makeDevelopmentTaskRow("dev-1"),
      makeHandoffRow("handoff-1"),
    ];

    const result = selectCodeTasksFromRows(rows, 20);

    results.push(
      check(
        "[CaseD] DevelopmentTask/HandoffStateしか存在しない場合、CodeTaskは0件になる" +
          "(架空のCodeTaskを作らない)",
        result.length === 0,
        `result=${JSON.stringify(result)}`
      )
    );

  }

  // ==========================================================
  // Case E: 既存CodeTaskとの後方互換性
  // (recordKindを一切持たない、Phase102以前からの既存データ形状)
  // ==========================================================

  {

    const legacyRow = { content: makeCodeTask({ id: "legacy-ct-1" }) };

    // recordKindフィールド自体が存在しないことを明示的に確認する
    // (Phase101以前に保存された既存CodeTaskの実データ形状と同じ)。
    results.push(
      check(
        "[CaseE-1] 既存CodeTaskのcontentにはrecordKindフィールドが存在しない(前提の確認)",
        !("recordKind" in legacyRow.content)
      )
    );

    const result = selectCodeTasksFromRows([legacyRow], 20);

    results.push(
      check(
        "[CaseE-2] recordKindを持たない既存CodeTaskは、引き続き正常に取得できる(後方互換)",
        result.length === 1 && result[0].id === "legacy-ct-1"
      )
    );

  }

  // ==========================================================
  // limitの絞り込みが、除外後の件数に対して正しく効くことの確認
  // ==========================================================

  {

    const rows = [
      makeDevelopmentTaskRow("dev-1"),
      { content: makeCodeTask({ id: "ct-1" }) },
      makeHandoffRow("handoff-1"),
      { content: makeCodeTask({ id: "ct-2" }) },
      { content: makeCodeTask({ id: "ct-3" }) },
    ];

    const result = selectCodeTasksFromRows(rows, 2);

    results.push(
      check(
        "[Limit] 非CodeTask行を除外した『後』にlimit件へ絞り込む" +
          "(非CodeTask行がlimit枠を消費して実際のCodeTaskが減らないことの確認)",
        result.length === 2 && result[0].id === "ct-1" && result[1].id === "ct-2",
        `result=${JSON.stringify(result.map((t) => t.id))}`
      )
    );

  }

  return summarize("codeAgent-listCodeTasks-non-code-task-filter (Phase 103)", results);

}
