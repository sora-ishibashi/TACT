// =========================
// TACT Work — Canonical Capability Router Regression (CAP-P1)
// =========================
//
// 対象: core/tact-work/capability.tsのresolveTaskCapabilities()/
// summarizeTaskCapabilities()/findUndeclaredTaskCapabilities()
// (いずれも純粋関数、DB/LLM/Search API呼び出しは0件)。既存の
// WorkCapabilityRequirement(core/tact-work/types.ts)・既存の
// assignedCapability文字列(core/tact-orchestrator/decomposer.ts)を
// そのまま入力として使う、read-onlyな分類・集約ヘルパーの回帰確認。

import {
  resolveTaskCapabilities,
  summarizeTaskCapabilities,
  findUndeclaredTaskCapabilities,
  CANONICAL_CAPABILITIES,
} from "../../../core/tact-work/capability";
import type { Work, WorkTask } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function task(assignedCapability: string | null | undefined): Pick<WorkTask, "assignedCapability"> {
  return { assignedCapability };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: resolveTaskCapabilities() — 既知dispatch keyの分類 ----
  {
    results.push(
      check(
        '[Test1] resolveTaskCapabilities("research") -> ["research.perform"]',
        JSON.stringify(resolveTaskCapabilities("research")) === JSON.stringify(["research.perform"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.gmail.search_messages") -> ["communication.read"]',
        JSON.stringify(resolveTaskCapabilities("integration.gmail.search_messages")) ===
          JSON.stringify(["communication.read"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.gmail.send_message") -> ["communication.write"]',
        JSON.stringify(resolveTaskCapabilities("integration.gmail.send_message")) ===
          JSON.stringify(["communication.write"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.slack.send_message") -> ["communication.write"]',
        JSON.stringify(resolveTaskCapabilities("integration.slack.send_message")) ===
          JSON.stringify(["communication.write"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.slack.list_channels") -> ["organizational_context.read"]',
        JSON.stringify(resolveTaskCapabilities("integration.slack.list_channels")) ===
          JSON.stringify(["organizational_context.read"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.notion.search") -> ["organizational_context.read"]',
        JSON.stringify(resolveTaskCapabilities("integration.notion.search")) ===
          JSON.stringify(["organizational_context.read"])
      )
    );

    results.push(
      check(
        '[Test1] resolveTaskCapabilities("integration.notion.read_page") -> ["organizational_context.read"]',
        JSON.stringify(resolveTaskCapabilities("integration.notion.read_page")) ===
          JSON.stringify(["organizational_context.read"])
      )
    );
  }

  // ---- Test2: fail closed — 未知dispatch key / null / undefinedはundefinedを返す ----
  {
    results.push(
      check(
        '[Test2] resolveTaskCapabilities("integration.unknown_provider.some_action") -> undefined (fail closed, 推測しない)',
        resolveTaskCapabilities("integration.unknown_provider.some_action") === undefined
      )
    );

    results.push(
      check(
        '[Test2] resolveTaskCapabilities(null) -> undefined',
        resolveTaskCapabilities(null) === undefined
      )
    );

    results.push(
      check(
        '[Test2] resolveTaskCapabilities(undefined) -> undefined (chat fallback, capability要件なし)',
        resolveTaskCapabilities(undefined) === undefined
      )
    );

    results.push(
      check(
        '[Test2] resolveTaskCapabilities("") -> undefined',
        resolveTaskCapabilities("") === undefined
      )
    );
  }

  // ---- Test3: providerがcapability名として誤読されない ----
  {
    const gmailRead = resolveTaskCapabilities("integration.gmail.search_messages");
    const notionRead = resolveTaskCapabilities("integration.notion.search");

    results.push(
      check(
        "[Test3] 異なるproviderの同じCapability(communication.read/organizational_context.read等)は同じCanonical Capability値に正規化される -- provider名がcapability結果に混入しない",
        gmailRead?.[0] === "communication.read" &&
          notionRead?.[0] === "organizational_context.read" &&
          !JSON.stringify(gmailRead).includes("gmail") &&
          !JSON.stringify(notionRead).includes("notion")
      )
    );
  }

  // ---- Test4: CANONICAL_CAPABILITIES — 既存WorkCapabilityRequirementのsupersetである ----
  {
    results.push(
      check(
        "[Test4] CANONICAL_CAPABILITIESは既存WorkCapabilityRequirementの3値を全て含む",
        CANONICAL_CAPABILITIES.includes("organizational_context.read") &&
          CANONICAL_CAPABILITIES.includes("communication.read") &&
          CANONICAL_CAPABILITIES.includes("communication.write")
      )
    );

    results.push(
      check(
        "[Test4] CANONICAL_CAPABILITIESは重複なく4値ちょうど(既存3値 + research.perform)",
        CANONICAL_CAPABILITIES.length === 4 &&
          new Set(CANONICAL_CAPABILITIES).size === 4
      )
    );
  }

  // ---- Test5: summarizeTaskCapabilities() — 異なるTaskが異なるCapabilityを持てる ----
  {
    const tasks = [
      task("integration.gmail.search_messages"),
      task("integration.notion.search"),
      task("research"),
    ];

    const summary = summarizeTaskCapabilities(tasks);

    results.push(
      check(
        "[Test5] 同一Work配下の異なるTaskが異なるCapabilityを保持できる(1 Work: N Capability)",
        summary.includes("communication.read") &&
          summary.includes("organizational_context.read") &&
          summary.includes("research.perform") &&
          summary.length === 3
      )
    );
  }

  // ---- Test6: summarizeTaskCapabilities() — 同じCapabilityは複数Taskで再利用可能(重複排除) ----
  {
    const tasks = [
      task("integration.gmail.search_messages"),
      task("integration.notion.search"), // 別providerだが同じCanonical Capability
    ];

    const summary = summarizeTaskCapabilities(tasks);

    results.push(
      check(
        "[Test6] 同じCanonical Capability(organizational_context.read)は複数Taskにまたがっても重複せず1件に集約される",
        summary.filter((c) => c === "organizational_context.read").length === 1
      )
    );
  }

  // ---- Test7: summarizeTaskCapabilities() — 未知/null/undefinedのTaskは黙って無視される(fail closed、例外なし) ----
  {
    const tasks = [
      task("integration.gmail.search_messages"),
      task("integration.unknown_provider.some_action"),
      task(null),
      task(undefined),
    ];

    const summary = summarizeTaskCapabilities(tasks);

    results.push(
      check(
        "[Test7] 未知/null/undefinedのassignedCapabilityは例外を投げず、Canonical Capability集合に混入しない",
        JSON.stringify(summary) === JSON.stringify(["communication.read"])
      )
    );
  }

  // ---- Test8: summarizeTaskCapabilities() — 空配列はundeclaredではなく空集合 ----
  {
    results.push(
      check(
        "[Test8] Task 0件のWorkはCanonical Capability要件も空配列(要件を捏造しない)",
        JSON.stringify(summarizeTaskCapabilities([])) === "[]"
      )
    );
  }

  // ---- Test9: findUndeclaredTaskCapabilities() — Work宣言と実際のTask使用の乖離検出(非enforcing) ----
  {
    const work: Pick<Work, "requiredCapabilities"> = {
      requiredCapabilities: ["organizational_context.read"],
    };

    const tasks = [
      task("integration.notion.search"), // organizational_context.read (宣言済み)
      task("integration.gmail.send_message"), // communication.write (未宣言)
    ];

    const undeclared = findUndeclaredTaskCapabilities(work, tasks);

    results.push(
      check(
        "[Test9] Work.requiredCapabilitiesに宣言されていないCapabilityをTaskが使っている場合、drift検出として返す",
        JSON.stringify(undeclared) === JSON.stringify(["communication.write"])
      )
    );
  }

  // ---- Test10: findUndeclaredTaskCapabilities() — 全て宣言済みなら空配列 ----
  {
    const work: Pick<Work, "requiredCapabilities"> = {
      requiredCapabilities: ["communication.read", "communication.write"],
    };

    const tasks = [
      task("integration.gmail.search_messages"),
      task("integration.gmail.send_message"),
    ];

    results.push(
      check(
        "[Test10] 使用されているCapabilityが全てWork.requiredCapabilitiesに宣言済みなら空配列を返す",
        JSON.stringify(findUndeclaredTaskCapabilities(work, tasks)) === "[]"
      )
    );
  }

  // ---- Test11: findUndeclaredTaskCapabilities() — requiredCapabilitiesがnull/undefinedでも安全 ----
  {
    const workNull: Pick<Work, "requiredCapabilities"> = { requiredCapabilities: null };
    const workUndefined: Pick<Work, "requiredCapabilities"> = {};

    const tasks = [task("integration.gmail.search_messages")];

    results.push(
      check(
        "[Test11] Work.requiredCapabilitiesがnull/undefinedでも例外を投げず、全使用Capabilityをundeclaredとして返す",
        JSON.stringify(findUndeclaredTaskCapabilities(workNull, tasks)) === JSON.stringify(["communication.read"]) &&
          JSON.stringify(findUndeclaredTaskCapabilities(workUndefined, tasks)) === JSON.stringify(["communication.read"])
      )
    );
  }

  // ---- Test12: findUndeclaredTaskCapabilities() — research.performはWorkCapabilityRequirementのDB制約対象外のため、比較から自然に除外される ----
  {
    const work: Pick<Work, "requiredCapabilities"> = { requiredCapabilities: [] };
    const tasks = [task("research")];

    results.push(
      check(
        '[Test12] "research.perform"はWork.requiredCapabilitiesへ書き込めない値(DB CHECK制約外)のため、drift検出の対象にならず空配列を返す',
        JSON.stringify(findUndeclaredTaskCapabilities(work, tasks)) === "[]"
      )
    );
  }

  // ---- Test13: side-effect-free — 同じ入力を繰り返し呼んでも結果が変わらない(純粋関数であることの確認) ----
  {
    const tasks = [task("integration.slack.send_message"), task("research")];

    const first = summarizeTaskCapabilities(tasks);
    const second = summarizeTaskCapabilities(tasks);

    results.push(
      check(
        "[Test13] summarizeTaskCapabilities()は副作用を持たない純粋関数(同じ入力 -> 同じ出力、何度呼んでも安定)",
        JSON.stringify(first) === JSON.stringify(second)
      )
    );
  }

  return summarize("work/capability", results);

}
