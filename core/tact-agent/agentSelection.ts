// =========================
// Coding Agent Selection(Phase111)
// =========================
//
// 「今どのCoding Agentを使うべきか」を決定する、副作用を持たない
// 純粋関数。core/codeAgent/(実行境界)・core/tact-agent/handoffManager.ts
// (永続化)のどちらにも依存しない、独立したDomain Logicとして置く
// (将来Cost/Quota/Task typeを追加してもここだけを拡張すればよいように
// するため)。
//
// 決定ルール(指示された最低限のルールをそのまま実装、過度な最適化は
// しない):
//   1. 現在Agentが利用可能かつ未試行なら、現在Agentを優先する
//   2. 現在Agentが利用不可/試行済みの場合、別の利用可能かつ未試行の
//      Agentへ切り替える
//   3. 同じAgentへの即時再試行は、attemptedAgentsによって防止される
//      (呼び出し側が「今回のRun内で既に試したAgent」を積み上げて
//      渡す。core/tact-agent/codingTaskRunner.tsが実際に積み上げる)
//   4. 利用可能なAgentが1つだけならそれを選ぶ(ルール1/2の結果として
//      自然に成立する)
//   5. 利用可能なAgent(未試行)が0件なら、明確にunavailableを返す
//   6. Claude Code/Codexという固有名を一切ハードコードしない
//      (candidatesは呼び出し側が渡す自由なagentIdのリスト)

import { AgentCandidate } from "./types";

export interface SelectCodingAgentInput {

  candidates: AgentCandidate[];

  // 直前までこのTaskを担当していたAgent(未割り当てならundefined)。
  currentAgent?: string;

  // 今回のRun(1回のrunCodingTask()呼び出し)内で、既に選択・実行を
  // 試みたAgentIdの一覧。無限Handoffループ防止のための最小限の状態
  // (Step4絶対条件)。selectCodingAgent自身は状態を保持しない
  // (呼び出し側であるcodingTaskRunner.tsが積み上げて毎回渡す)。
  attemptedAgents?: string[];

}

export type SelectCodingAgentResult =
  | { status: "selected"; agentId: string; reason: string }
  | { status: "unavailable"; reason: string };

export function selectCodingAgent(
  input: SelectCodingAgentInput
): SelectCodingAgentResult {

  const attemptedAgents = input.attemptedAgents ?? [];

  // ルール1: 現在Agentが利用可能かつ未試行なら、現在Agentを優先する。
  if (input.currentAgent) {

    const current = input.candidates.find(
      (candidate) => candidate.agentId === input.currentAgent
    );

    if (
      current &&
      current.availability.available &&
      !attemptedAgents.includes(current.agentId)
    ) {

      return {
        status: "selected",
        agentId: current.agentId,
        reason: "現在のAgentが利用可能かつ未試行のため、現在のAgentを継続する。",
      };

    }

  }

  // ルール2/4: 利用可能かつ未試行の別Agentへ切り替える
  // (candidatesの並び順を、呼び出し側が渡した優先順としてそのまま
  // 尊重する。ここでAgent固有の優先順位をハードコードしない)。
  const next = input.candidates.find(
    (candidate) =>
      candidate.availability.available &&
      !attemptedAgents.includes(candidate.agentId)
  );

  if (next) {

    return {
      status: "selected",
      agentId: next.agentId,
      reason: input.currentAgent
        ? "現在のAgentが利用不可、または今回のRunで試行済みのため、" +
          `別の利用可能なAgent(${next.agentId})へ切り替える。`
        : `利用可能なAgent(${next.agentId})を選択する。`,
    };

  }

  // ルール5: 利用可能(かつ未試行)なAgentが1つも無い。
  return {
    status: "unavailable",
    reason:
      "利用可能(かつ今回のRunで未試行)なCoding Agentが存在しない。" +
      `candidates=${JSON.stringify(
        input.candidates.map((c) => ({ agentId: c.agentId, available: c.availability.available }))
      )}, attemptedAgents=${JSON.stringify(attemptedAgents)}`,
  };

}
