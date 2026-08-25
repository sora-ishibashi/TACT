// =========================
// TACT Discovery → Deepening Candidate Extraction Regression (Phase 93)
// =========================
//
// 対象: core/tact-research/candidateDiscovery.ts
// (discoverCandidateEntities()・selectDeepeningCandidates())、
// core/tact-research/queryGeneration.ts(buildDeepeningQueries())。
//
// 環境制約(Phase66〜92と同一): 実DB書き込み・実LLM API・実Search API
// は一切呼ばない。いずれも純粋関数のみ。
//
// スコープの明示: runResearch.ts内部でのDiscovery→Deepening配線
// (performWebResearch()を2回呼ぶかどうかの分岐)自体は、
// runResearch(params, core)の公開シグネチャをSTEP176から一切変更しない
// という既存の絶対条件があり、既存テストもrunResearch()へ
// searchImpl等のDIフックを持たない(performWebResearch()側にのみ
// DIパラメータがある設計、Phase20〜24のコメント参照)。そのため本
// ファイルでは、Discovery/Deepeningの核となる決定論的な構成要素
// (Candidate抽出・対象選定・Query生成)を直接テストし、配線自体の
// 最終確認は次のReality Test(ユーザー許可後)に委ねる。

import "dotenv/config";
import {
  discoverCandidateEntities,
  selectDeepeningCandidates,
  type CandidateEntity,
} from "../../../core/tact-research/candidateDiscovery";
import { buildDeepeningQueries } from "../../../core/tact-research/queryGeneration";
import type { Evidence } from "../../../core/context/types";
import { check, summarize, type CheckResult } from "../lib/check";

// Phase92 Reality Testで実際にBrave/Tavilyから返ってきた実データを
// fixtureとして使う(job.career-tasu.jp/ONE CAREER/イベカツ等、実際に
// ポータルと判定されるべきタイトル)。
function makeEvidence(overrides: Partial<Evidence> & { id: string; claim: string }): Evidence {

  return {
    evidence: "",
    confidence: "medium",
    score: 0.5,
    createdBy: "researcher",
    createdAt: Date.now(),
    tags: [],
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Discovery: ポータルサイトそのものを最終Entityとして扱わない
  // ==========================================================

  {
    const portalEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "愛知県で実施 - インターンシップ・キャリア情報一覧 | インターンシップ・新卒採用情報サイト キャリタス就活",
        source: "https://job.career-tasu.jp/intern-search/lst-isArea-04/lst-isPref-23/",
      }),
      makeEvidence({
        id: "e2",
        claim: "愛知県のインターンシップ一覧｜就活イベントを探すなら【ONE CAREER】",
        source: "https://www.onecareer.jp/events/internship/area/4/23",
      }),
      makeEvidence({
        id: "e3",
        claim: "愛知県 | 【イベカツ】 合同説明会・就活セミナー・就活イベント情報のポータルサイト",
        source: "https://evekatsu.com/gousetsu/prefectures/aichi",
      }),
    ];

    const candidates = discoverCandidateEntities(portalEvidence);

    results.push(
      check(
        "[Discovery-1] 「一覧」「ポータルサイト」を含むポータルタイトルはCandidate Entityにならない" +
          "(Phase90〜92の実Reality Testで確認された3ポータル全てを除外できる)",
        candidates.length === 0,
        `candidates=${JSON.stringify(candidates)}`
      )
    );

  }

  {
    const mixedEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "愛知県のインターンシップ一覧｜就活イベントを探すなら【ONE CAREER】",
        source: "https://www.onecareer.jp/events/internship/area/4/23",
      }),
      makeEvidence({
        id: "e2",
        claim: "名古屋インターンシップフェア2026",
        source: "https://example.com/nagoya-intern-fes-2026",
        evidence: "2026年9月20日開催。参加費無料。対象は大学3〜4年生。",
      }),
    ];

    const candidates = discoverCandidateEntities(mixedEvidence);

    results.push(
      check(
        "[Discovery-2] ポータルと個別イベントが混在する場合、個別イベントらしいものだけが" +
          "Candidate Entityとして抽出される",
        candidates.length === 1 && candidates[0].name === "名古屋インターンシップフェア2026",
        `candidates=${JSON.stringify(candidates)}`
      )
    );

    results.push(
      check(
        "[Discovery-3] Candidate EntityはURL(由来元Evidenceのsource)を保持する",
        candidates[0]?.url === "https://example.com/nagoya-intern-fes-2026"
      )
    );

    results.push(
      check(
        "[Discovery-4] Candidate Entityは由来元のevidenceIdを保持する(後段のDeepening対象選定・" +
          "Evidence参照に使うための内部情報)",
        candidates[0]?.evidenceId === "e2"
      )
    );

  }

  {
    const shortTitleEvidence: Evidence[] = [
      makeEvidence({ id: "e1", claim: "8月", source: "https://example.com/short" }),
    ];

    results.push(
      check(
        "[Discovery-5] 極端に短いタイトル(固有名詞と判断できない)はCandidateにしない",
        discoverCandidateEntities(shortTitleEvidence).length === 0
      )
    );

  }

  // ==========================================================
  // Deepening対象選定: 既にAttributeが揃っているCandidateは対象外
  // ==========================================================

  {
    const alreadyRichCandidate: CandidateEntity = {
      name: "名古屋インターンシップフェア2026",
      url: "https://example.com/a",
      source: "https://example.com/a",
      evidenceId: "e1",
      evidenceText: "名古屋インターンシップフェア2026 開催日: 2026年9月20日 参加費: 無料 定員: 100名",
    };

    const missingAttributesCandidate: CandidateEntity = {
      name: "豊田キャリアイベント2026",
      url: "https://example.com/b",
      source: "https://example.com/b",
      evidenceId: "e2",
      evidenceText: "豊田キャリアイベント2026の開催情報ページ",
    };

    const selected = selectDeepeningCandidates([alreadyRichCandidate, missingAttributesCandidate]);

    results.push(
      check(
        "[Deepening-1] 既定Attribute(開催日/参加費/定員)がEvidence本文に揃っているCandidateは" +
          "Deepening対象から除外される(無駄な検索を増やさない)",
        !selected.some((c) => c.name === alreadyRichCandidate.name),
        `selected=${JSON.stringify(selected.map((c) => c.name))}`
      )
    );

    results.push(
      check(
        "[Deepening-2] Attributeが不足しているCandidateはDeepening対象になる",
        selected.some((c) => c.name === missingAttributesCandidate.name)
      )
    );

  }

  {
    const manyCandidates: CandidateEntity[] = Array.from({ length: 8 }, (_, i) => ({
      name: `候補イベント${i + 1}`,
      url: `https://example.com/${i + 1}`,
      source: `https://example.com/${i + 1}`,
      evidenceId: `e${i + 1}`,
      evidenceText: `候補イベント${i + 1}の情報ページ`,
    }));

    const selectedDefault = selectDeepeningCandidates(manyCandidates);

    results.push(
      check(
        "[Deepening-3] Candidateが多数あっても既定上限(5件)を超えてDeepening対象にしない" +
          "(無制限Search Loop禁止、Section7・20)",
        selectedDefault.length === 5,
        `count=${selectedDefault.length}`
      )
    );

    const selectedWithRequestedRowCount = selectDeepeningCandidates(manyCandidates, {
      requestedRowCount: 2,
    });

    results.push(
      check(
        "[Deepening-4] requestedRowCountが指定されている場合、既定上限より小さければそちらを優先する" +
          "(要求件数が少ないのに過剰にDeepeningしない)",
        selectedWithRequestedRowCount.length === 2,
        `count=${selectedWithRequestedRowCount.length}`
      )
    );

  }

  {
    results.push(
      check(
        "[Deepening-5] Candidateが1件も無い場合、Deepening対象も0件になる(不要なDeepeningを実行しない)",
        selectDeepeningCandidates([]).length === 0
      )
    );

  }

  // ==========================================================
  // Deepening Query生成: Entity名 + Attributeから決定論的に生成する
  // ==========================================================

  {
    const queries = buildDeepeningQueries(
      ["名古屋インターンシップフェア2026", "豊田キャリアイベント2026"],
      ["開催日", "参加費", "対象学年", "開催形式", "定員"]
    );

    results.push(
      check(
        "[QueryGen-1] Table Schemaの列がある場合、Candidate名+その列名でDeepening Queryを生成する" +
          "(LLMにQueryを自由生成させない、決定論的な文字列連結のみ)",
        queries.length === 2 &&
          queries[0] === "名古屋インターンシップフェア2026 開催日 参加費 対象学年 開催形式 定員" &&
          queries[1] === "豊田キャリアイベント2026 開催日 参加費 対象学年 開催形式 定員",
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  {
    const queries = buildDeepeningQueries(["名古屋インターンシップフェア2026"]);

    results.push(
      check(
        "[QueryGen-2] Table Schemaが無い場合も、既定Attribute(開催日/参加費/定員)でQueryを生成する" +
          "(Table要求が無いResearchでも構造化を試みる、Section2)",
        queries.length === 1 && queries[0].includes("名古屋インターンシップフェア2026") &&
          queries[0].includes("開催日") && queries[0].includes("参加費") && queries[0].includes("定員"),
        `queries=${JSON.stringify(queries)}`
      )
    );

  }

  results.push(
    check(
      "[QueryGen-3] Candidate名が空配列ならQueryも0件(無駄な検索をしない)",
      buildDeepeningQueries([]).length === 0
    )
  );

  // ==========================================================
  // Future Consumer Compatibility: Research DatasetがTable UI固有の
  // 構造に依存していないことの確認(Section16・23)
  // ==========================================================

  {
    const evidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "名古屋インターンシップフェア2026",
        source: "https://example.com/a",
      }),
    ];

    const candidates = discoverCandidateEntities(evidence);
    const candidateKeys = Object.keys(candidates[0] ?? {}).sort();

    results.push(
      check(
        "[FutureConsumer-1] CandidateEntityはname/url/source/evidenceId/evidenceTextのみを持ち、" +
          "Table固有のフィールド(columns/rows/cellSourceEvidenceIds等)を一切含まない" +
          "(Table Builderに依存しない、Comparison Table以外のConsumer(Graph/3C/SWOT等)からも" +
          "将来利用可能な素データであることの最小確認)",
        JSON.stringify(candidateKeys) ===
          JSON.stringify(["evidenceId", "evidenceText", "name", "source", "url"]),
        `keys=${JSON.stringify(candidateKeys)}`
      )
    );

  }

  return summarize("discovery-deepening-candidate-extraction (Phase 93)", results);

}
