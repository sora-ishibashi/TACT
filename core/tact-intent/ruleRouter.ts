import type { IntentDecision } from "./types";

// =========================
// classifyIntent (STEP216)
// =========================
//
// TACTの新しい入口(components/tact/ResearchSection.tsx)が、入力を
// 3つの既存経路(chat / research / core_push)のどこへ渡すかを判定する
// 純粋関数。LLMは一切使わない(STEP216絶対条件: Rule Routerのコストは
// 常にゼロ)。core/agents・core/planner・core/workflow・core/conversation
// のいずれにも依存しない。
//
// 設計方針:
// - 単純なキーワード部分一致(「調べる」という文字列が含まれるかだけを
//   見る等)は使わない。「調べるってどういう意味?」のような、単語への
//   言及であって依頼ではない入力を誤ってresearchと判定してしまうため。
//   そのため「動詞の語幹 + 依頼を表す活用形(て/てほしい/てもらえる等)」
//   の組み合わせでのみ一致させる(辞書形「調べる」単体では一致しない)。
// - 判定順序: core_push → research → chat(既定)。
//   core_pushは「TACT Coreへの書き込み」という最も明確な意図を示す
//   語のため最初に見る。researchはコストを伴う(Search/LLM)ため、
//   はっきりした依頼表現がある場合のみ一致させる。どちらにも一致
//   しない入力はすべてchatへ落ちる(STEP216-I: 曖昧な入力は安全側の
//   chatを既定とする)。

// 「覚え/記憶し/保存し/登録し」+ 依頼を表す活用形の組み合わせ。
// 辞書形("覚える"等)単体には一致しない。
const CORE_PUSH_PATTERN =
  /(覚え|記憶し|保存し|登録し)(て|ておいて|てほしい|てもらえる)/;

// 「調べ/調査/リサーチ」+ 依頼を表す活用形の組み合わせ。
// 「調べるって」のような辞書形+「って」には一致しない
// (「調べ」の直後が「て」ではなく「る」のため)。
const RESEARCH_PATTERN =
  /(調べ|調査し|リサーチし)(て|てほしい|てもらえる|てください)/;

export function classifyIntent(input: string): IntentDecision {

  const trimmed = input.trim();

  if (!trimmed) {

    // ResearchSection.tsx側で空入力は送信前に弾く既存実装だが、
    // classifyIntent自体を将来他所から呼んでも安全なように、ここでも
    // 明示的にchatへフォールバックする(API呼び出しは発生しない)。
    return { intent: "chat", reason: "empty input" };

  }

  if (CORE_PUSH_PATTERN.test(trimmed)) {

    return {
      intent: "core_push",
      // STEP216スコープ外の自動分類(knowledge/memory/exampleの
      // 精密な判別)は行わない。「覚えて」系の表現はCoreMemoryの
      // 定義(好み・ルール・文脈等の記憶)に最も近いため、Rule Router
      // からの既定typeは"memory"に固定する。
      corePushType: "memory",
      reason: "matched core_push pattern (覚え/記憶/保存/登録 + 依頼表現)",
    };

  }

  if (RESEARCH_PATTERN.test(trimmed)) {

    return {
      intent: "research",
      reason: "matched research pattern (調べ/調査/リサーチ + 依頼表現)",
    };

  }

  return {
    intent: "chat",
    reason: "no research/core_push pattern matched (default to chat)",
  };

}
