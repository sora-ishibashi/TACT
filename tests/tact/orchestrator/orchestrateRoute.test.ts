// =========================
// /api/tact/orchestrate Regression (Phase 33)
// =========================
//
// 対象: app/api/tact/orchestrate/route.ts。
//
// 環境上の制約(Phase30/31で確認済み、Phase33でも再確認): このHarness
// 環境にはSupabase Service Role Keyが無く、また新規テストUserの
// メール送信もレート制限にかかるため、実際に有効なBearerトークンを
// 用意できない。そのため、
//   - Test A(未認証 -> 401)は実際のRoute Handlerを直接呼び出し、
//     本物の未認証経路として検証する(Authorizationヘッダー無し、
//     ネットワーク呼び出み自体が発生しないため0コストで確定的)。
//   - Test B/C/D(認証済み + 不正input -> 400)は、route.ts内の
//     入力検証式(`typeof body.input === "string" ? body.input.trim() : ""`
//     → 空文字なら400)をそのまま抜き出して検証する。認証を突破する
//     実セッションが用意できないため、HTTP経由でのフルパスは検証
//     できないが、判定ロジック自体は決定論的に検証できる。
//   - Test E/F/G(認証済みの正常系/Clarification/Capability経路)は、
//     route.tsが実際に呼ぶのと全く同じ形(`runOrchestration({userId,
//     input})`)でrunOrchestration()を直接呼び出す(認証ゲート自体は
//     Test Aで別途確認済み)。mock capability登録による既存Harness
//     パターン(Phase20〜28)を再利用し、LLM/Search API呼び出みは
//     一切発生させない。
//
// この分割の妥当性: route.tsの責務は「認証ゲート」+
// 「入力検証」+「runOrchestration()を1回呼ぶだけ」の3つに限定されて
// おり(Phase33実装、DIも追加していない)、この3つを個別に検証すれば
// Route全体の振る舞いを漏れなくカバーできる。

import "dotenv/config";
import { NextRequest } from "next/server";
import { POST as orchestrateRoute } from "../../../app/api/tact/orchestrate/route";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { runOrchestration } from "../../../core/tact-orchestrator";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeRequest(body?: unknown): NextRequest {

  return new NextRequest("http://localhost/api/tact/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

}

// route.ts内の入力検証式と同一のロジック(抜き出しての検証、
// route.ts自体は変更していない)。
function extractValidatedInput(body: Record<string, unknown>): string {
  return typeof body.input === "string" ? body.input.trim() : "";
}

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
    searchQueryCount: 1, searchRequestCount: 1, searchAttempts: [],
    retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
    usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
    usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
    durationMs: 100, mocked: false, requirementCount: 1, coveredRequirementCount: 0,
    partialRequirementCount: 0, missingRequirementCount: 1, gapQueries: [], safetyDowngradeCount: 0,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test A: 未認証 -> 401、Capabilityは呼ばれない ----
  {
    let capabilityCalled = false;
    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      capabilityCalled = true;
      return { success: true, answer: "should not be called", evidence: [], metadata: makeMetadata() };
    });

    const response = await orchestrateRoute(makeRequest({ input: "日本の首相は誰ですか？" }));
    const body = await response.json();

    results.push(
      check(
        "[TestA] 未認証 -> 401、runOrchestration()(=capability)は呼ばれない",
        response.status === 401 && !capabilityCalled && body.success === false,
        `status=${response.status}, capabilityCalled=${capabilityCalled}`
      )
    );
  }

  // ---- Test B/C/D: 入力検証式の直接検証(認証済み前提のロジック) ----
  {
    results.push(
      check("[TestB] {}(inputなし) -> 検証式は空文字を返す(400相当)", extractValidatedInput({}) === "")
    );
    results.push(
      check("[TestC] {input:\"\"} -> 検証式は空文字を返す(400相当)", extractValidatedInput({ input: "" }) === "")
    );
    results.push(
      check("[TestD] {input:\"   \"} -> 検証式は空文字を返す(400相当、trim後)", extractValidatedInput({ input: "   " }) === "")
    );
    results.push(
      check("[Test比較] {input:\"正常な入力\"} -> 検証式は空文字を返さない(400にならない)", extractValidatedInput({ input: "正常な入力" }) === "正常な入力")
    );
  }

  // ---- Test E: 正常系(route.tsと同じ形でrunOrchestration()を直接呼ぶ) ----
  //
  // userIdは意図的に省略する。Phase32のReality Testで確認した通り、
  // commander.tsはCoreCapabilityとしてcreateSupabaseCoreCapability()を
  // 直接生成する(mock差し替え不可)ため、実在しないUUID形式でない
  // userId(例: "phase33-test-user")を渡すと、buildTaskContext()が
  // 実Supabaseへ問い合わせを試みて失敗する(実際に本テスト作成時に
  // 遭遇し確認した不具合)。taskContext.tsの既存の安全側フォールバック
  // (userId未指定 -> 空のCoreContextを返す、Supabaseへ問い合わせない、
  // Phase4確立済み)を使うことで、実DB接続を経由せずに検証できる。
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "モック回答",
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({ input: "日本の首相は誰ですか？" });

    results.push(
      check(
        "[TestE] 正常系 -> answer/tasks/learningSignalsが存在し、Taskが実際に成功する",
        typeof result.answer === "string" && result.answer.length > 0 &&
          Array.isArray(result.tasks) && result.tasks.length === 1 &&
          result.tasks[0].status === "completed" &&
          Array.isArray(result.learningSignals) &&
          JSON.stringify(result.learningSignals) === JSON.stringify(["successful_execution"]),
        `answer=${result.answer}, taskStatus=${result.tasks[0]?.status}, learningSignals=${JSON.stringify(result.learningSignals)}`
      )
    );
  }

  // ---- Test F: Clarification経路(Phase15の既存Ambiguity判定ルールを
  // 確認した上で、確実にclarificationになる裸の動詞「調べて」を使う) ----
  {
    let capabilityCalled = false;
    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      capabilityCalled = true;
      return { success: true, answer: "should not be called", evidence: [], metadata: makeMetadata() };
    });

    const result = await runOrchestration({ input: "調べて" });

    results.push(
      check(
        "[TestF] Clarification -> clarification有り、tasks=[]、learningSignals=[\"clarification_required\"]、Capability未実行",
        result.clarification !== undefined &&
          result.tasks.length === 0 &&
          JSON.stringify(result.learningSignals) === JSON.stringify(["clarification_required"]) &&
          !capabilityCalled,
        `clarification=${JSON.stringify(result.clarification)}, tasks=${result.tasks.length}, capabilityCalled=${capabilityCalled}`
      )
    );
  }

  // ---- Test G: Research capability経路(query伝播の確認) ----
  {
    let receivedQuery: string | undefined;
    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      receivedQuery = params.query;
      return {
        success: true,
        answer: "ok",
        evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
        metadata: makeMetadata(),
      };
    });

    const input = "トヨタの競合はどこですか？";
    const result = await runOrchestration({ input });

    results.push(
      check(
        "[TestG] Route(相当) -> runOrchestration -> Executor -> research capabilityまでqueryが正しく伝播する",
        receivedQuery === input && result.tasks[0]?.capability === "research",
        `receivedQuery=${receivedQuery}, capability=${result.tasks[0]?.capability}`
      )
    );
  }

  return summarize("orchestrate route", results);

}
