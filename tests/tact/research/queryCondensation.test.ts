// =========================
// TACT Research Query Condensation Regression (Phase 92)
// =========================
//
// 対象: core/tact-research/queryGeneration.tsのbuildResearchQueries()
// (該当カテゴリが無いqueryへの、複数文検知+トピック抽出クエリの追加)。
//
// Root Cause(Phase92投資調査、Repository Evidence: Phase91 Reality Test):
// User Query → decomposeIntoRequirements() → (Turn1/Turn3補足Researchの
// ような、既存6ルールいずれにも一致しない複数文の依頼文は分解されず
// 単一Requirement=生の全文になる) → buildGapResearchQueries() →
// buildResearchQueries(requirement.query)(該当カテゴリなし) →
// 修正前は生の全文(「確認できない情報は推測せず、確認できないものとして
// 扱ってください」等のメタ指示文を含む)がそのままSearch Providerへの
// 唯一のQueryになっていた(performWebResearch()→tavilyProvider.search()
// まで一切変換されないことをコードレベルで追跡・確認済み)。
//
// 切り分け結果(Phase92 Section2の3分類):
//   - Search Provider自体の問題ではない(Tavily/Braveへ渡すqueryを
//     変えれば挙動が変わりうる)。
//   - LLM回答生成の問題でもない(evidence.evidenceには正規化前の
//     生ページ本文がそのまま渡っており、normalizeResult()・
//     contextAssembly.tsのいずれにも文字数制限は無いことを確認済み)。
//   - Search Queryの問題(本ファイルの対象): 決定論的なQuery生成
//     (decomposeIntoRequirements→buildResearchQueries)が、複数文の
//     自然文依頼をキーワードへ変換せず、メタ指示文ごと丸ごとSearch
//     Providerへ渡していた。
//
// 方針(Phase92絶対条件A・C): Table Builder・Table Schema伝播・
// Grounding層は一切変更しない。既存のextractResearchTopic()
// (Phase88、新しいNLU無し)を再利用し、buildResearchQueries()の
// 「該当カテゴリが無い場合」の分岐にのみ、複数文の場合の追加候補
// Queryを1件だけ足す(既存のqueryそのものは必ず残す——
// tactArtifactPhase83.test.tsのTestK-1・queryTopicContinuation.test.tsの
// CompetitorFP/CompetitorTP-3が要求する「queries.includes(query)」
// 「queries.length===1」という既存契約を壊さない)。
//
// Discovery/Deepeningの2段階検索ループ(Phase92指示のSection4)は、
// 今回は実装していない。Root Cause調査により「Search Queryにメタ
// 指示文が混入していた」という、より狭く・低リスクな原因が既に
// コードレベルで確定したため、まずこの最小修正のみをReality Testで
// 検証し(Phase92指示Section16の停止条件に従う)、これでも個別Entityが
// 得られない場合に初めてDiscovery→Deepeningの必要性を判断する。
//
// 環境制約(Phase66〜91と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数のみ。

import "dotenv/config";
import {
  buildResearchQueries,
  extractResearchTopic,
} from "../../../core/tact-research/queryGeneration";
import { groundParsedEntities } from "../../../core/tact-conversation/artifactMutation";
import type { ParsedStructuredEntity } from "../../../core/tact-conversation/artifactMutation";
import type { ResearchEvidenceItem } from "../../../core/tact-research/types";
import { assembleResearchContext } from "../../../core/tact-research/contextAssembly";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // Phase90/91 Reality Testで実際にTavilyへ送られたTurn1の生文面
  // (fixtureとしてそのまま使用)。
  const turn1RawInput =
    "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベントについて調査してください。" +
    "2026年8月〜10月に開催されるものを中心に、大学生が実際に参加しやすそうなイベントを探してください。" +
    "後で比較表にすることを想定して、イベント名、開催日、参加費、対象学年、開催形式、定員など、" +
    "数字や条件で比較できる情報を優先してください。" +
    "確認できない情報は推測せず、確認できないものとして扱ってください。";

  // ==========================================================
  // Test1: Discovery相当 — 複数文の生入力から、トピックのみへ
  // 凝縮した追加Queryが生成される
  // ==========================================================

  {
    const queries = buildResearchQueries(turn1RawInput);
    const condensedTopic = extractResearchTopic(turn1RawInput);

    results.push(
      check(
        "[Test1-1] 複数文の生入力(Phase91 Reality Test実文面)から、メタ指示文を含まないトピックのみの" +
          "Queryが追加生成される",
        queries.includes(condensedTopic) &&
          condensedTopic === "愛知県内で、大学生が参加しやすいインターンシップ・キャリアイベント",
        `queries=${JSON.stringify(queries)}`
      )
    );

    results.push(
      check(
        "[Test1-2] 凝縮Queryには「確認できない情報は推測せず」等のメタ指示文が含まれない" +
          "(Search Providerへ渡るキーワードからノイズが除去される)",
        !condensedTopic.includes("推測") && !condensedTopic.includes("確認できない")
      )
    );

  }

  // ==========================================================
  // Test2: Deepening相当(既存詳細維持) — 元の生Queryは必ず残る。
  // Table Schemaの列に対応する語彙(開催日/参加費/対象学年/開催形式/
  // 定員)は凝縮Queryでは失われるが、元Queryには残るため検索対象
  // から完全には失われない
  // ==========================================================

  {
    const queries = buildResearchQueries(turn1RawInput);

    results.push(
      check(
        "[Test2-1] 元の生Query(全文)は削除されず、必ずqueriesに残る" +
          "(既存Regression Testの「queries.includes(query)」契約を壊さない)",
        queries.includes(turn1RawInput)
      )
    );

    results.push(
      check(
        "[Test2-2] Table Schemaの列に対応する語彙(開催日・参加費・対象学年・開催形式・定員)は、" +
          "元のQueryを通じて検索対象から失われない(凝縮Queryはトピックのみで良く、" +
          "詳細条件の担保は既存Queryへ委ねる、責務を混ぜない設計)",
        queries.some(
          (q) =>
            q.includes("開催日") &&
            q.includes("参加費") &&
            q.includes("対象学年") &&
            q.includes("開催形式") &&
            q.includes("定員")
        ),
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // Test3: 単一文(「。」を含まない)queryは影響を受けない
  // (既存tactArtifactPhase83.test.ts TestK-1・
  // queryTopicContinuation.test.tsのCompetitorFP/CompetitorTP-3が
  // 要求する厳密な契約の再確認)
  // ==========================================================

  {
    const singleSentenceQuery = "愛知県の大学生が参加できる就活イベントを5件";
    const queries = buildResearchQueries(singleSentenceQuery);

    results.push(
      check(
        "[Test3-1] 「。」を含まない単一文queryは、従来通りqueryそのもの1件のみになる(過剰な分割をしない)",
        queries.length === 1 && queries[0] === singleSentenceQuery,
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  {
    // 「を調査してください」で終わる単一文(「。」なし)は、
    // extractResearchTopic()を通すとqueryと異なる値になり得るが、
    // 「。」を含まないため本Phaseの凝縮ロジックの対象外のまま
    // (queryTopicContinuation.test.tsのCompetitorTP-3と同じ入力で
    // 直接再確認する)。
    const query = "他社サービスとの違いを調査してください";
    const queries = buildResearchQueries(query);

    results.push(
      check(
        "[Test3-2] 「。」を含まない単一文は、末尾が依頼動詞句(「を調査してください」)でも凝縮されない" +
          "(「。」の有無だけを凝縮のトリガーにする、単一文の意図しない改変を避ける)",
        queries.length === 1 && queries[0] === query,
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // Test4: 該当カテゴリ(会社/市場/競合)に一致するqueryは、
  // 本Phaseの変更の影響を受けない(既存分岐が優先される)
  // ==========================================================

  {
    const query = "競合サービスを比較してください。詳細な条件も教えてください。";
    const queries = buildResearchQueries(query);

    results.push(
      check(
        "[Test4-1] 「競合」を含み複数文でもある入力は、従来通りcompetitorカテゴリの接尾辞付与が優先され、" +
          "本Phaseの凝縮ロジック(該当カテゴリが無い場合のみ動作)は発動しない",
        queries.some((q) => q.includes(`${query} 競合`)) && queries.includes(query),
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // Test5: 凝縮後にqueryと同じ値になる場合は追加しない(無駄な
  // Search呼び出しを増やさない)
  // ==========================================================

  {
    // 「。」を含むが、末尾が依頼動詞句パターンに一致しないため
    // extractResearchTopic()が実質的に変化を生まないケース。
    const query = "愛知県のイベント一覧。5件教えて。";
    const queries = buildResearchQueries(query);
    const condensed = extractResearchTopic(query);

    results.push(
      check(
        "[Test5-1] 凝縮結果が元のqueryと同じ場合は重複追加しない",
        condensed === query ? queries.length === 1 : true,
        `condensed=${JSON.stringify(condensed)}, queries=${JSON.stringify(queries)}`
      )
    );

  }

  // ==========================================================
  // Test6(既存カバレッジの明示的な再確認、Phase92指示Section11の
  // 4/5/6/8に対応): 凝縮Queryの追加は、Grounding層・No-Fabrication・
  // Table Schema無しRunResearchの既存契約に影響しない。
  // 詳細な検証はtactArtifactPhase82/83.test.ts・
  // tableAwareResearch.test.tsで既にカバーされているため、ここでは
  // 「Query生成の変更がこれらの層のI/Fに影響しない」ことだけを
  // 最小限のfixtureで直接確認する(重複した網羅テストは作らない)。
  // ==========================================================

  {
    const evidencePool: ResearchEvidenceItem[] = [
      {
        id: "e1",
        claim: "名古屋インターンフェス",
        source: "https://example.com/nagoya-intern-fes",
        confidence: "high",
        snippet: "名古屋インターンフェスは2026年9月20日に開催。参加費は無料。対象は大学3年生。",
      },
    ];

    const parsed: ParsedStructuredEntity[] = [
      {
        title: "名古屋インターンフェス",
        fields: [
          { label: "開催日", value: "2026年9月20日" },
          { label: "参加費", value: "無料" },
          { label: "定員", value: "300名" }, // Evidenceに存在しない値
        ],
      },
    ];

    const grounded = groundParsedEntities(parsed, evidencePool);

    results.push(
      check(
        "[Test6-1] Query生成の変更後も、Evidenceに存在する値のみがsourceEvidenceIds付きでEntity化される" +
          "(Grounding層は無変更)",
        grounded.length === 1 &&
          grounded[0].entity.fields.find((f) => f.label === "開催日")?.sourceEvidenceIds?.includes("e1") === true,
        `grounded=${JSON.stringify(grounded)}`
      )
    );

    results.push(
      check(
        "[Test6-2] Evidenceに存在しない「定員」は情報未確認になる(捏造しない、No-Fabrication無変更)",
        grounded[0].entity.fields.find((f) => f.label === "定員")?.value === "情報未確認",
        `fields=${JSON.stringify(grounded[0].entity.fields)}`
      )
    );

  }

  {
    // Table Schema無しの通常Research(Phase90以前と同じ経路)が、
    // 本Phaseのquery生成変更後もsystemPromptへ一切影響しないことを
    // 直接確認する(tableAwareResearch.test.tsの[Prompt-1]と同じ観点、
    // Query生成層とPrompt層が独立していることの再確認)。
    const withoutSchema = assembleResearchContext({
      query: turn1RawInput,
      context: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
      evidence: [],
      requirements: [],
    });

    results.push(
      check(
        "[Test6-3] Table Schema未指定時、Query生成の変更後もsystemPromptに列構成セクションが追加されない" +
          "(Query生成層とPrompt層が独立、Table Schemaが無い通常Researchへの回帰なし)",
        !withoutSchema.systemPrompt.includes("比較表(Comparison Table)としての回答形式")
      )
    );

  }

  return summarize("research-query-condensation (Phase 92)", results);

}
