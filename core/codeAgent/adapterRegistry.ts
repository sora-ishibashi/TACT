// =========================
// Coding Agent Adapter Registry(STEP144-B)
// =========================
//
// STEP142で CodingAgentAdapter インターフェースと ClaudeCodeAdapter を
// 実装済みだったが、呼び出し側(app/api/tact/code-tasks/execute/route.ts)
// は `new ClaudeCodeAdapter()` を直接生成していたため、実際の交換点が
// 存在しなかった。このファイルが、その交換点(=生成の一箇所化)を担う。
//
// TACT Code
//   ↓
// CodingAgentAdapter (interface, core/codeAgent/types.ts)
//   ↓
// getCodingAgentAdapter(providerId)  ← 交換点はここだけ
//   ├─ "claude-code" → ClaudeCodeAdapter(今回実装済み)
//   ├─ "codex"        → 将来
//   └─ "gemini-code"   → 将来
//
// 今回、Codex/Gemini等の新しいAdapterを実装する必要はない
// (STEP144-Bの指示どおり、境界の設計のみが目的)。

import { CodingAgentAdapter } from "./types";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter";

export type CodingAgentProviderId = "claude-code";

const DEFAULT_PROVIDER: CodingAgentProviderId = "claude-code";

export function getCodingAgentAdapter(
  providerId: CodingAgentProviderId = DEFAULT_PROVIDER
): CodingAgentAdapter {

  switch (providerId) {

    case "claude-code":
      return new ClaudeCodeAdapter();

    default: {

      // TypeScriptのexhaustive checkのため。CodingAgentProviderIdに
      // 新しい値を追加した場合、ここでコンパイルエラーになる
      // (対応するAdapterの実装漏れを防ぐ)。
      const _exhaustiveCheck: never = providerId;
      throw new Error(`Unknown CodingAgentProviderId: ${_exhaustiveCheck}`);

    }

  }

}
