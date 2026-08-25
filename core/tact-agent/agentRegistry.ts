// =========================
// Agent Registry
// =========================
//
// core/tact-core/capabilities/registry.tsと同じ設計判断
// (名前ベースの登録/参照だけを提供する、Mapベースの単純なRegistry。
// LLM/NLUは一切使わない)。「どのAgentが存在するか・現在の状態」を
// 1箇所で把握できるようにするだけで、Agentの実行方法(Claude Code
// CLIの起動方法等)はcore/codeAgent/側の責務のまま持ち込まない。

import { Agent, AgentStatus } from "./types";

const agents = new Map<string, Agent>();

// 同名の再登録は上書きする(registry.tsのregisterCapability()と同じ、
// テスト時の再登録・開発時のホットリロードを妨げないための方針)。
export function registerAgent(agent: Agent): void {

  agents.set(agent.agentId, agent);

}

export function getAgent(agentId: string): Agent | undefined {

  return agents.get(agentId);

}

export function listAgents(): Agent[] {

  return Array.from(agents.values());

}

export function updateAgentStatus(
  agentId: string,
  status: AgentStatus
): Agent | undefined {

  const existing = agents.get(agentId);

  if (!existing) {
    return undefined;
  }

  const updated: Agent = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };

  agents.set(agentId, updated);

  return updated;

}

// Unit Test間での状態リークを避けるための補助
// (registry.tsのclearCapabilityRegistry()と同じ位置づけ、本番用途ではない)。
export function clearAgentRegistry(): void {

  agents.clear();

}

// =========================
// bootstrapDefaultAgents
// =========================
//
// 今回のユースケース(Claude Code → Codex)で最低限必要な2つのAgent
// identityを登録する。Codex自体の実行Adapterは今回実装しない
// (core/codeAgent/adapterRegistry.tsのコメントにも"codex" → 将来と
// 明記されている、既存拡張点を尊重する)ため、statusは
// "unavailable"のまま登録するに留める(架空の実行可否を報告しない)。
let bootstrapped = false;

export function bootstrapDefaultAgents(): void {

  if (bootstrapped) {
    return;
  }

  const now = new Date().toISOString();

  registerAgent({
    agentId: "claude-code",
    name: "Claude Code",
    provider: "anthropic",
    capabilities: ["code_edit", "git", "test_execution", "research"],
    status: "available",
    registeredAt: now,
    updatedAt: now,
  });

  registerAgent({
    agentId: "codex",
    name: "Codex",
    provider: "openai",
    capabilities: ["code_edit", "git", "test_execution"],
    // Adapter未実装のため、実行可能とは報告しない(架空の成功を返さない)。
    status: "unavailable",
    registeredAt: now,
    updatedAt: now,
  });

  bootstrapped = true;

}
