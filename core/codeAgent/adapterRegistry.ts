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
//   ├─ "claude-code" → ClaudeCodeAdapter(実装済み)
//   ├─ "codex"        → CodexAdapter(Phase104で追加。isAvailable()は
//   │                    常にfalseを返す最小実装——実行不可を実行可能と
//   │                    偽装しない、Phase104絶対条件)
//   └─ "gemini-code"   → 将来
//
// Phase104: Codexの"将来"だった拡張点を、この交換点(スイッチ文)に
// 1ケース追加するだけで実際に埋める。CodingAgentAdapter interface・
// 呼び出し側(app/api/tact/code-tasks/execute/route.ts等)は無変更。

import { CodingAgentAdapter } from "./types";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter";
import { CodexAdapter } from "./codexAdapter";

export type CodingAgentProviderId = "claude-code" | "codex";

const DEFAULT_PROVIDER: CodingAgentProviderId = "claude-code";

export function getCodingAgentAdapter(
  providerId: CodingAgentProviderId = DEFAULT_PROVIDER
): CodingAgentAdapter {

  switch (providerId) {

    case "claude-code":
      return new ClaudeCodeAdapter();

    case "codex":
      return new CodexAdapter();

    default: {

      // TypeScriptのexhaustive checkのため。CodingAgentProviderIdに
      // 新しい値を追加した場合、ここでコンパイルエラーになる
      // (対応するAdapterの実装漏れを防ぐ)。
      const _exhaustiveCheck: never = providerId;
      throw new Error(`Unknown CodingAgentProviderId: ${_exhaustiveCheck}`);

    }

  }

}
