// =========================
// TACT Orchestrator — Semantic-first Capability Planning Regression
// (CAP-P1c)
// =========================
//
// 対象: core/tact-orchestrator/capabilityPlan.ts
// (planCapabilityForIntent()/resolveCapabilityForBinding()/
// isBindingCompatibleWithCapability()/listKnownExecutionBindings())と、
// それを実際に消費するdecomposeTask()(core/tact-orchestrator/
// decomposer.ts)。いずれも純粋関数、LLM/Search API/DB呼び出しは0件
// (Category A、Deterministic Evaluation)。
//
// このfileが検証する中核契約(CAP-P1c指示Section2/6): decomposeTask()
// が生成するTaskは、Task meaning(=classifyIntent()の判定結果、または
// Context Resolution Planのsource)から、Canonical Capability(WHAT)と
// execution binding(HOW、既存のassignedCapability)を同じ1つの
// CapabilityPlanから同時に導出する——「dispatch keyを先に決めて
// Canonical Capabilityを事後的に逆算する」という順序に戻っていない
// ことを、resolveTaskCapabilities()を単体で呼ぶのではなく、実際の
// decomposeTask()の出力Taskで直接確認する。

import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import {
  planCapabilityForIntent,
  resolveCapabilityForBinding,
  isBindingCompatibleWithCapability,
  listKnownExecutionBindings,
} from "../../../core/tact-orchestrator/capabilityPlan";
import type { OrchestrationRequest } from "../../../core/tact-orchestrator/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. Gmail search planning: Task meaning(自然文のGmail検索要求)
  // → communication.read → integration.gmail.search_messages、という
  // 意味論的な関係がdecomposeTask()の出力Task 1件から直接確認できる ----
  {
    const tasks = decomposeTask({ input: "取引先からのメールを検索して" });

    results.push(
      check(
        "[Test1] Gmail search planning: Task 1件がcanonicalCapability=communication.read かつ assignedCapability=integration.gmail.search_messagesを同時に持つ",
        tasks.length === 1 &&
          tasks[0].canonicalCapability === "communication.read" &&
          tasks[0].assignedCapability === "integration.gmail.search_messages"
      )
    );
  }

  // ---- 2. Gmail send: decomposeTask()自身はGmail送信Taskを生成しない
  // (REF-P1fの別経路、Referent解決 + Approval必須)が、compatibility
  // tableはこのbindingとcommunication.writeの組を正しく認識しており、
  // providerへの書き込みは一切発生しない(純粋な同期比較のみ) ----
  {
    results.push(
      check(
        "[Test2] Gmail send binding: communication.write ⇄ integration.gmail.send_messageは互換(Approval経路は別途必須のまま、ここではProvider書き込みは一切発生しない)",
        resolveCapabilityForBinding("integration.gmail.send_message") === "communication.write" &&
          isBindingCompatibleWithCapability("communication.write", "integration.gmail.send_message") === true
      )
    );
  }

  // ---- 3. Notion search/read planning ----
  {
    const searchTasks = decomposeTask({ input: "Notionでプロジェクト計画を検索して" });
    const readTasks = decomposeTask({ input: "Notionのプロジェクト計画を読んで" });

    results.push(
      check(
        "[Test3] Notion search/read planning: いずれもorganizational_context.readへ、対応する既存execution bindingとともに解決される",
        searchTasks.length === 1 &&
          searchTasks[0].canonicalCapability === "organizational_context.read" &&
          searchTasks[0].assignedCapability === "integration.notion.search" &&
          readTasks.length === 1 &&
          readTasks[0].canonicalCapability === "organizational_context.read" &&
          readTasks[0].assignedCapability === "integration.notion.read_page"
      )
    );
  }

  // ---- 3b. Context Resolution Plan(Slack context由来、
  // classifyIntent()を経由しない別のTask生成経路)でも同じ意味論的
  // Capabilityが宣言される ----
  {
    const request: OrchestrationRequest = {
      input: "(context-derived)",
      contextResolutionPlan: {
        kind: "ready",
        requestText: "更新案件を確認して",
        sources: {
          notion: { query: "更新案件" },
          gmail: { query: "更新案件" },
        },
      },
    };

    const tasks = decomposeTask(request);
    const notionSearch = tasks.find((t) => t.assignedCapability === "integration.notion.search");
    const notionRead = tasks.find((t) => t.assignedCapability === "integration.notion.read_page");
    const gmailSearch = tasks.find((t) => t.assignedCapability === "integration.gmail.search_messages");

    results.push(
      check(
        "[Test3b] Context Resolution Plan由来のNotion/Gmail Taskも、classifyIntent()経由の同じCapabilityPlanから同じcanonicalCapabilityを持つ(生のdispatch key文字列を別途書き下ろしていない)",
        tasks.length === 3 &&
          notionSearch?.canonicalCapability === "organizational_context.read" &&
          notionRead?.canonicalCapability === "organizational_context.read" &&
          gmailSearch?.canonicalCapability === "communication.read"
      )
    );
  }

  // ---- 4. Research planning(simple/compare/sequential、いずれも
  // research.performへ、既存のresearch execution bindingとともに
  // 解決される) ----
  {
    const simple = decomposeTask({ input: "日本の首相は誰ですか？" });
    const compare = decomposeTask({ input: "トヨタについて調べて、ホンダと比較して" });
    const sequential = decomposeTask({ input: "トヨタについて調べて、その結果をもとに要約してください" });

    results.push(
      check(
        "[Test4] Research planning: simple/compare/sequentialのいずれのresearch Taskも、canonicalCapability=research.perform かつ assignedCapability=researchを同時に持つ。sequentialの後続要約Taskはcapability要件を持たない(chat fallback)",
        simple[0]?.canonicalCapability === "research.perform" &&
          simple[0]?.assignedCapability === "research" &&
          compare.every((t) => t.canonicalCapability === "research.perform" && t.assignedCapability === "research") &&
          sequential[0]?.canonicalCapability === "research.perform" &&
          sequential[1]?.canonicalCapability === undefined &&
          sequential[1]?.assignedCapability === undefined
      )
    );
  }

  // ---- 5. Capability/binding mismatch: fail closed ----
  {
    results.push(
      check(
        "[Test5] Capability/binding mismatch(例: communication.write + integration.gmail.search_messages、Section6の明示例)はfail closed(false)",
        isBindingCompatibleWithCapability("communication.write", "integration.gmail.search_messages") === false &&
          isBindingCompatibleWithCapability("communication.read", "integration.gmail.send_message") === false &&
          isBindingCompatibleWithCapability("organizational_context.read", "integration.gmail.search_messages") === false
      )
    );
  }

  // ---- 6/7. 未知のCanonical Capability/未知のexecution bindingは
  // 黙って有効なcanonical routingとして扱われない ----
  {
    results.push(
      check(
        '[Test6/7] 未登録のexecution binding("integration.unknown_provider.some_action")はresolveCapabilityForBinding()でundefined、どのCanonical Capabilityとも互換にならない(silent dispatchしない)',
        resolveCapabilityForBinding("integration.unknown_provider.some_action") === undefined &&
          isBindingCompatibleWithCapability("communication.read", "integration.unknown_provider.some_action") === false &&
          isBindingCompatibleWithCapability("research.perform", "integration.unknown_provider.some_action") === false
      )
    );

    results.push(
      check(
        "[Test6/7] null/undefined/空文字のbindingもfail closed(undefined/false)であり、決して黙って有効なCapabilityとみなされない",
          resolveCapabilityForBinding(null) === undefined &&
          resolveCapabilityForBinding(undefined) === undefined &&
          resolveCapabilityForBinding("") === undefined &&
          isBindingCompatibleWithCapability("communication.read", null) === false
      )
    );
  }

  // ---- chat/core_pushはCapability要件を持たない、というplanning結果
  // 自体も明示的(nullであり、未対応で埋め忘れたのではない) ----
  {
    results.push(
      check(
        "[chat/core_push] planCapabilityForIntent()は\"chat\"/\"core_push\"に対して明示的にnullを返す(Capability Registry dispatchを必要としない正当な結果)",
        planCapabilityForIntent("chat") === null &&
          planCapabilityForIntent("core_push") === null
      )
    );
  }

  // ---- listKnownExecutionBindings(): 診断用ヘルパーが既存の全既知
  // dispatch key(Gmail send含む)を認識している ----
  {
    const bindings = listKnownExecutionBindings();

    results.push(
      check(
        "[diagnostics] listKnownExecutionBindings()は既存の全既知execution binding(Gmail send含む)を認識している",
        bindings.includes("research") &&
          bindings.includes("integration.gmail.search_messages") &&
          bindings.includes("integration.gmail.send_message") &&
          bindings.includes("integration.slack.send_message") &&
          bindings.includes("integration.slack.list_channels") &&
          bindings.includes("integration.notion.search") &&
          bindings.includes("integration.notion.read_page")
      )
    );
  }

  // ---- Section5: 「二つの曖昧な文字列」ではなく、型付き構造として
  // 共存する。同じTaskオブジェクト上でassignedCapability(自由文字列)
  // とcanonicalCapability(閉じたunion)が別々のfieldとして存在し、
  // 一方から他方を毎回文字列パースし直す必要が無い ----
  {
    const tasks = decomposeTask({ input: "取引先からのメールを検索して" });
    const task = tasks[0];

    results.push(
      check(
        "[typed structure] assignedCapabilityとcanonicalCapabilityは同じTask上の別々のfieldであり、一方が他方の文字列変換ではない(型として独立)",
        typeof task.assignedCapability === "string" &&
          typeof task.canonicalCapability === "string" &&
          task.assignedCapability !== task.canonicalCapability
      )
    );
  }

  // ---- side-effect-free: Capability選択自体はLLM/Search/Provider
  // 呼び出しを一切発生させない(decomposeTask()自体が既存の
  // ルールベース・同期関数であることの直接確認——非同期APIを一切
  // 呼ばず、Promiseを返さない) ----
  {
    const start = Date.now();
    const tasks = decomposeTask({ input: "取引先からのメールを検索して" });
    const elapsedMs = Date.now() - start;

    results.push(
      check(
        "[side-effect-free] decomposeTask()は同期的に完了する(Capability Planningの選択自体がProvider呼び出しを一切発生させない構造的証拠)",
        tasks.length === 1 && elapsedMs < 50
      )
    );
  }

  return summarize("orchestrator/capabilityPlan", results);

}
