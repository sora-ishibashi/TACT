// =========================
// Query-side Freshness Signal Regression (Phase 42)
// =========================
//
// 対象: core/tact-research/answerability.ts の TIME_SENSITIVE_PATTERNS
// (「は誰/はどなた」追加)・SIMPLE_FACT_PATTERNS(「代表者」除外)。
//
// Phase41で発見した「代表者/CEO/学長等は本質的に時間依存(在任者が
// 交代しうる)だが、明示的な時制語(最新/現在等)を伴わない質問は
// Core-onlyへ通ってしまう」問題の回帰防止。assessAnswerability()
// (直接判定)・detectKnowledgeGap()+canAnswerAllFromCoreOnly()
// (Knowledge Gap経由、hasTimeSensitiveSignal()を共有する別経路)の
// 両方を対象に検証する。knowledgeGap.ts自体は変更していない
// (Phase42絶対条件12)。LLM/Search API呼び出しは0件。

import { assessAnswerability, hasTimeSensitiveSignal } from "../../../core/tact-research/answerability";
import { detectKnowledgeGap, canAnswerAllFromCoreOnly } from "../../../core/tact-research/knowledgeGap";
import type { CoreContext } from "../../../core/tact-core/context/types";
import type { KnowledgeItem } from "../../../core/tact-core/knowledge/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeKnowledge(id: string, title: string, content: string): KnowledgeItem {
  return {
    id, scope: "user", ownerId: "phase42-test-user", source: "user_push",
    tags: [], createdAt: new Date().toISOString(),
    kind: "reference", title, content, updatedAt: new Date().toISOString(),
  };
}

function makeContext(knowledge: KnowledgeItem[]): CoreContext {
  return { knowledge, memories: [], examples: [], recentExecutions: [] };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test A: 明示的時間依存("現在")は従来どおりCore-onlyに入らない(回帰) ----
  {
    const context = makeContext([makeKnowledge("k1", "トヨタの社長", "トヨタの社長は佐藤太郎です。")]);
    const query = "現在のトヨタの社長は誰ですか？";
    const answerability = assessAnswerability(query, context);
    const canAnswerGap = canAnswerAllFromCoreOnly(query, detectKnowledgeGap(query, context));

    results.push(check(
      "[TestA] 「現在のトヨタの社長は誰ですか？」-> assessAnswerability/knowledgeGap両方ともCore-onlyへ入らない(回帰)",
      !answerability.canAnswerFromCoreOnly && !canAnswerGap
    ));
  }

  // ---- Test B(最重要): 「代表者は誰ですか」は両経路ともCore-onlyへ入らない ----
  {
    const context = makeContext([makeKnowledge("k2", "トヨタの代表者", "トヨタの代表者は佐藤太郎です。")]);
    const query = "トヨタの代表者は誰ですか？";
    const answerability = assessAnswerability(query, context);
    const canAnswerGap = canAnswerAllFromCoreOnly(query, detectKnowledgeGap(query, context));

    results.push(check(
      "[TestB] 「トヨタの代表者は誰ですか？」-> assessAnswerability/knowledgeGap両方ともCore-onlyへ入らない(Phase42修正の主目的)",
      !answerability.canAnswerFromCoreOnly && !canAnswerGap,
      `assessAnswerability=${answerability.canAnswerFromCoreOnly}, knowledgeGap=${canAnswerGap}`
    ));
  }

  // ---- Test C: 「代表者は?」(誰を伴わない短縮形)はassessAnswerability側は
  // 修正済み(SIMPLE_FACT_PATTERNSから除外)だが、knowledgeGap経由は
  // 明示的な時制語が無いため依然としてCore-onlyへ入りうる(既知の残存
  // リスク、Phase42では役職名の列挙・LLM判定を用いずに閉じることは
  // しないと判断したため、意図的に未修正のまま記録する) ----
  {
    const context = makeContext([makeKnowledge("k3", "トヨタの代表者", "トヨタの代表者は佐藤太郎です。")]);
    const query = "トヨタの代表者は？";
    const answerability = assessAnswerability(query, context);
    const canAnswerGap = canAnswerAllFromCoreOnly(query, detectKnowledgeGap(query, context));

    results.push(check(
      "[TestC] 「トヨタの代表者は？」-> assessAnswerabilityは修正によりfalse(SIMPLE_FACT_PATTERNSから代表者を除外)",
      !answerability.canAnswerFromCoreOnly
    ));

    results.push(check(
      "[TestC-既知の残存リスク] 「トヨタの代表者は?」-> knowledgeGap経由は明示的時制語が無いためtrueのまま" +
        "(役職名列挙・LLM判定によるさらなる修正は今回のスコープ外、報告書に明記)",
      canAnswerGap === true
    ));
  }

  // ---- Test D: 「学長は誰ですか」は両経路ともCore-onlyへ入らない ----
  {
    const context = makeContext([makeKnowledge("k4", "中京大学の学長", "中京大学の学長は工藤悟です。")]);
    const query = "中京大学の学長は誰ですか？";
    const answerability = assessAnswerability(query, context);
    const canAnswerGap = canAnswerAllFromCoreOnly(query, detectKnowledgeGap(query, context));

    results.push(check(
      "[TestD] 「中京大学の学長は誰ですか？」-> assessAnswerability/knowledgeGap両方ともCore-onlyへ入らない",
      !answerability.canAnswerFromCoreOnly && !canAnswerGap
    ));
  }

  // ---- Test E: 既存simple fact("〜とは")は従来どおりCore-onlyに入る(回帰) ----
  {
    const context = makeContext([makeKnowledge("k5", "中京大学とは", "中京大学は愛知県名古屋市にある私立大学です。")]);
    const query = "中京大学とは？";
    const answerability = assessAnswerability(query, context);

    results.push(check(
      "[TestE] 「中京大学とは？」-> 従来どおりCore-onlyへ入る(回帰なし)",
      answerability.canAnswerFromCoreOnly === true
    ));
  }

  // ---- Test F: 所在地(SIMPLE_FACT_PATTERNSに維持した語)は従来どおり(回帰) ----
  {
    const context = makeContext([makeKnowledge("k6", "中京大学の所在地", "中京大学は愛知県名古屋市にあります。")]);
    const query = "中京大学の所在地は？";
    const answerability = assessAnswerability(query, context);

    results.push(check(
      "[TestF] 「中京大学の所在地は？」-> 所在地は維持したため従来どおりCore-onlyへ入る(回帰なし)",
      answerability.canAnswerFromCoreOnly === true
    ));
  }

  // ---- Test G: 無関係な質問はmissing判定のまま(回帰) ----
  {
    const context = makeContext([makeKnowledge("k7", "トヨタの代表者", "トヨタの代表者は佐藤太郎です。")]);
    const query = "三角形の内角の和は？";
    const answerability = assessAnswerability(query, context);
    const requirements = detectKnowledgeGap(query, context);

    results.push(check(
      "[TestG] 無関係な質問はmissing判定のまま、Core-onlyへ入らない(回帰なし)",
      !answerability.canAnswerFromCoreOnly && requirements.every((r) => r.status === "missing")
    ));
  }

  // ---- Test H: hasTimeSensitiveSignal()単体の追加パターン確認 ----
  {
    results.push(check("[TestH] 「〜は誰ですか」はtrue", hasTimeSensitiveSignal("〜は誰ですか？")));
    results.push(check("[TestH] 「〜はどなたですか」はtrue", hasTimeSensitiveSignal("〜はどなたですか？")));
    results.push(check("[TestH] 「〜とは」(誰を含まない)はfalse", !hasTimeSensitiveSignal("中京大学とは？")));
  }

  return summarize("answerability freshness signal (Phase 42)", results);

}
