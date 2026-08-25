// =========================
// Evidence.publishedAt propagation Regression (Phase 43)
// =========================
//
// 対象: Tavily検索結果 -> SearchResult.publishedAt(core/search/types.ts)
// -> normalizeResult()(core/tools/pipeline/normalize.ts) ->
// buildEvidence()(core/tools/pipeline/evidence.ts)という伝播経路。
//
// Phase41で確認した「Evidence.publishedAtは型としては存在するが、
// buildEvidence()がpublishedAt: undefinedを無条件でハードコードして
// いたため常にundefinedだった」問題の回帰防止。実Search API呼び出しは
// 0件(buildEvidence()へ渡す生データをmockで用意する)。
//
// 重要: freshnessWeight()(core/evidence/retrieveEvidence.ts)・
// scoreEvidence()(core/evidence/scoreEvidence.ts)自体のアルゴリズムは
// 変更していない。実データが流れることで既存ロジックの出力が変わる
// ことだけを確認する(絶対条件: freshnessWeight実装そのものの変更禁止)。

import { buildEvidence } from "../../../core/tools/pipeline/evidence";
import { scoreEvidence } from "../../../core/evidence/scoreEvidence";
import { retrieveEvidence } from "../../../core/evidence/retrieveEvidence";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test 1: publishedAtありのTavily形式結果 -> Evidence.publishedAtへ伝播 ----
  {
    const rawResults = [
      {
        title: "中京大学 - Wikipedia",
        url: "https://example.com/chukyo",
        content: "中京大学は愛知県名古屋市にある私立大学です。",
        score: 0.9,
        publishedAt: "2024-06-01T00:00:00.000Z",
      },
    ];

    const evidence = buildEvidence(rawResults);

    results.push(
      check(
        "[Test1] publishedAtあり -> Evidence.publishedAtが同じ日時を保持する",
        evidence[0]?.publishedAt === "2024-06-01T00:00:00.000Z",
        `publishedAt=${JSON.stringify(evidence[0]?.publishedAt)}`
      )
    );
  }

  // ---- Test 2: publishedAtなし -> Evidence.publishedAtはundefinedのまま(推測しない) ----
  {
    const rawResults = [
      {
        title: "中京大学とは",
        url: "https://example.com/chukyo2",
        content: "中京大学は愛知県名古屋市にある私立大学です。",
        score: 0.8,
        // publishedAtフィールド自体が存在しない(Providerが返さなかった場合を模す)
      },
    ];

    const evidence = buildEvidence(rawResults);

    results.push(
      check(
        "[Test2] publishedAtなし -> Evidence.publishedAtはundefinedのまま(推測値が入らない)",
        evidence[0]?.publishedAt === undefined
      )
    );
  }

  // ---- Test 3: retrievedAtとpublishedAtの分離 ----
  {
    const rawResults = [
      {
        title: "古い記事",
        url: "https://example.com/old-article",
        content: "2020年に公開された記事の内容。",
        score: 0.7,
        publishedAt: "2020-01-01T00:00:00.000Z",
      },
    ];

    const before = Date.now();
    const evidence = buildEvidence(rawResults);
    const after = Date.now();

    const retrievedAtMs = evidence[0]?.retrievedAt ? new Date(evidence[0].retrievedAt).getTime() : NaN;

    results.push(
      check(
        "[Test3] publishedAt(2020年)とretrievedAt(実行時刻)は異なる値として、それぞれ正しく保持される",
        evidence[0]?.publishedAt === "2020-01-01T00:00:00.000Z" &&
          evidence[0]?.publishedAt !== evidence[0]?.retrievedAt &&
          retrievedAtMs >= before && retrievedAtMs <= after,
        `publishedAt=${evidence[0]?.publishedAt}, retrievedAt=${evidence[0]?.retrievedAt}`
      )
    );
  }

  // ---- Test 4: freshnessWeight/scoreEvidenceは変更していないが、
  // 実データが流れることでスコアが変化することを確認する ----
  {
    const freshResult = {
      title: "最近の記事", url: "https://example.com/fresh", content: "本文",
      score: 0.5, publishedAt: new Date().toISOString(),
    };
    const noDateResult = {
      title: "日時不明の記事", url: "https://example.com/no-date", content: "本文",
      score: 0.5,
    };

    const freshEvidence = buildEvidence([freshResult])[0];
    const noDateEvidence = buildEvidence([noDateResult])[0];

    results.push(
      check(
        "[Test4a] scoreEvidence(): publishedAtあり(直近)はpublishedAtなしよりscoreが高い" +
          "(scoreEvidence自体は無変更、実データが流れた結果としての差分)",
        scoreEvidence(freshEvidence) > scoreEvidence(noDateEvidence),
        `fresh=${scoreEvidence(freshEvidence)}, noDate=${scoreEvidence(noDateEvidence)}`
      )
    );

    const ranked = retrieveEvidence([noDateEvidence, freshEvidence], "記事", 2);

    results.push(
      check(
        "[Test4b] retrieveEvidence(): freshnessWeight()に実データが流れ、直近publishedAtの" +
          "Evidenceがより高くランキングされる(retrieveEvidence自体は無変更)",
        ranked[0]?.id === freshEvidence.id,
        `ranked=${JSON.stringify(ranked.map((e) => e.id))}`
      )
    );
  }

  // ---- Test 5: 既存Evidence pipelineの回帰(claim/evidence/source/scoreが壊れていない) ----
  {
    const rawResults = [
      { title: "T1", url: "https://example.com/1", content: "C1", score: 0.6 },
    ];

    const evidence = buildEvidence(rawResults);

    results.push(
      check(
        "[Test5] 既存フィールド(claim/evidence/source)は従来どおり生成される(回帰なし)",
        evidence[0]?.claim === "T1" &&
          evidence[0]?.evidence === "C1" &&
          evidence[0]?.source === "https://example.com/1"
      )
    );
  }

  return summarize("evidence publishedAt propagation (Phase 43)", results);

}
