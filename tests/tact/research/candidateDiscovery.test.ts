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
  prioritizeIndividualEntityEvidence,
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
  // Phase97: Phase95/96の実データで確認されたfalse positiveパターンの
  // 追加Candidate判定(件数付き一覧・案内文型・複数主体型イベント+URL)。
  // 以下のtitle/urlは、断りが無い限りPhase95実Reality Testの実データ
  // (ResearchResult.evidenceにそのまま出現したclaim/source)をそのまま
  // fixture化したもの。
  // ==========================================================

  {
    // Phase95 Turn2実データ(internshipguide.jp、件数付き一覧)。
    const countedListingEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "愛知県のインターン・インターンシップ（2212件）",
        source: "https://internshipguide.jp/interns/japanInternList/23",
      }),
    ];

    results.push(
      check(
        "[Phase97-A] 件数付き一覧タイトル(「（2212件）」)はCandidateから除外される" +
          "(Phase95実データ、PORTAL_TITLE_MARKERSの固定8語に一致しないfalse negativeの修正確認)",
        discoverCandidateEntities(countedListingEvidence).length === 0
      )
    );

    // 半角括弧・別件数でも同じパターンとして判定できることを確認する。
    const halfWidthCountEvidence: Evidence[] = [
      makeEvidence({
        id: "e2",
        claim: "◯◯総合イベント情報サイト(123件)",
        source: "https://example.com/events",
      }),
    ];

    results.push(
      check(
        "[Phase97-A2] 半角括弧の件数付きタイトルも同様に除外される(表記揺れ耐性)",
        discoverCandidateEntities(halfWidthCountEvidence).length === 0
      )
    );

  }

  {
    // Phase95 Turn1実データ(job.rikunabi.com、案内文型「〜情報」で終わる)。
    const guidancePhraseEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "【リクナビ】愛知県 イベント インターンシップのインターンシップ情報",
        source: "https://job.rikunabi.com/kw/some-search-path/",
      }),
    ];

    results.push(
      check(
        "[Phase97-B] 案内文型タイトル(「〜情報」で終わる)はCandidateから除外される" +
          "(Phase95実データ、PORTAL_TITLE_MARKERSに一致しないfalse negativeの修正確認)",
        discoverCandidateEntities(guidancePhraseEvidence).length === 0
      )
    );

    results.push(
      check(
        "[Phase97-B2] 「〜はこちら」で終わる案内文型タイトルも同様に除外される",
        discoverCandidateEntities([
          makeEvidence({
            id: "e2",
            claim: "対象イベントの一次情報はこちら",
            source: "https://example.com/guide",
          }),
        ]).length === 0
      )
    );

    results.push(
      check(
        "[Phase97-B3] タイトル『中間』に「情報」を含むだけの個別Entityは除外されない" +
          "(末尾一致のみを対象にする設計により、過剰除外を避ける)",
        discoverCandidateEntities([
          makeEvidence({
            id: "e3",
            claim: "名古屋インターンシップフェア2026 開催情報まとめページ更新",
            source: "https://example.com/nagoya-intern-fes-2026-detail",
          }),
        ]).length === 1
      )
    );

  }

  {
    // Phase95 Turn2実データ(career-tasu.jp、onecareer.jp): タイトルは
    // 既存PORTAL_TITLE_MARKERS(「一覧」)にも一致するが、Section2の
    // URLベース補助判定が同時に成立することも確認する(組み合わせ判定の
    // 健全性確認、URL側だけを見ても壊れていないことの確認)。
    const portalUrlEvidence: Evidence[] = [
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
    ];

    const portalUrlCandidates = discoverCandidateEntities(portalUrlEvidence);

    results.push(
      check(
        "[Phase97-C] career-tasu.jp(URL: /intern-search/lst-...)はCandidateから除外される" +
          "(Phase95実データ、タイトル「一覧」+URL「/lst-」の両方がPortalシグナル)",
        !portalUrlCandidates.some((c) => c.evidenceId === "e1"),
        `candidates=${JSON.stringify(portalUrlCandidates.map((c) => c.evidenceId))}`
      )
    );

    results.push(
      check(
        "[Phase97-D] onecareer.jp(URL: /events/internship/area/4/23)はCandidateから除外される" +
          "(Phase95実データ、タイトル「一覧」+URL「/area/」の両方がPortalシグナル)",
        !portalUrlCandidates.some((c) => c.evidenceId === "e2"),
        `candidates=${JSON.stringify(portalUrlCandidates.map((c) => c.evidenceId))}`
      )
    );

    results.push(
      check(
        "[Phase97-CD] 両方ともタイトル側の強いシグナルで既に除外されるため、" +
          "この時点でCandidateは0件になる(組み合わせ判定に到達する前段の健全性確認)",
        portalUrlCandidates.length === 0
      )
    );

  }

  {
    // Phase95 Turn2実データ(internshipguide.jp、URL「japanInternList」)。
    // タイトル自体が件数付き一覧(Phase97-Aと同じパターン)のため、
    // タイトル側の強いシグナルだけで除外されることを確認する
    // (URLの大文字混じり「japanInternList」は本heuristicの
    // PORTAL_URL_MARKERSと厳密一致しないが、タイトル側が捕捉するため
    // 過検出にはならない)。
    const internshipGuideEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "愛知県のインターン・インターンシップ（1034件）",
        source: "https://internshipguide.jp/interns/japanInternList/23",
      }),
    ];

    results.push(
      check(
        "[Phase97-E] internshipguide.jp(件数付き一覧タイトル)はCandidateから除外される" +
          "(Phase95実データ)",
        discoverCandidateEntities(internshipGuideEvidence).length === 0
      )
    );

  }

  {
    // Phase97-F: 単一企業・単一イベント・具体的開催情報を含む個別Entityは
    // 新しいheuristic追加後も引き続きCandidateとして残ることを確認する
    // (false negativeの修正がfalse positiveを増やしていないことの確認)。
    const individualEntityEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "株式会社サンプル 1dayインターンシップ 2026年9月10日開催",
        source: "https://example.com/sample-corp/internship-20260910",
        evidence: "参加費無料、対象は大学3〜4年生、定員30名。",
      }),
    ];

    results.push(
      check(
        "[Phase97-F] 単一企業の具体的な開催情報を含むタイトルはCandidateとして残る" +
          "(新規heuristicによる過剰除外が発生していないことの確認)",
        discoverCandidateEntities(individualEntityEvidence).length === 1 &&
          discoverCandidateEntities(individualEntityEvidence)[0].name ===
            "株式会社サンプル 1dayインターンシップ 2026年9月10日開催"
      )
    );

  }

  {
    // Section4絶対条件: 「合同説明会」「EXPO」等の複数主体型イベント語を
    // 含んでいても、単語一致だけでは除外しない(それ自体が独立した1つの
    // Entityであり得るため)。既存Discovery-2の「名古屋インターンシップ
    // フェア2026」(通常URL)は引き続きCandidateとして残ることを確認済み
    // なので、ここではURLがPortalらしい場合にのみ除外されることを
    // 明示的に確認する。
    const weakSignalOnlyEvidence: Evidence[] = [
      makeEvidence({
        id: "e1",
        claim: "豊田キャリアEXPO2026",
        source: "https://example.com/toyota-career-expo-2026",
      }),
    ];

    results.push(
      check(
        "[Phase97-G1] 「EXPO」を含んでいても通常URL(Portalらしいパターンなし)なら" +
          "Candidateとして残る(単語単体では除外しない、過剰除外防止の確認)",
        discoverCandidateEntities(weakSignalOnlyEvidence).length === 1
      )
    );

    const weakSignalWithPortalUrlEvidence: Evidence[] = [
      makeEvidence({
        id: "e2",
        claim: "豊田キャリアEXPO2026",
        source: "https://example.com/category/career-expo-2026",
      }),
    ];

    results.push(
      check(
        "[Phase97-G2] 同じ「EXPO」タイトルでも、URLがPortalらしいパターン(「/category/」)と" +
          "一致する場合はCandidateから除外される(タイトル+URLの組み合わせ判定の確認、Section2)",
        discoverCandidateEntities(weakSignalWithPortalUrlEvidence).length === 0
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

  // ==========================================================
  // Phase99: 最終Evidence選定でのIndividual Entity優先
  // (prioritizeIndividualEntityEvidence()、Root Cause: Phase98実
  // Reality Testで、Deepeningが個別Entityを対象に検索できていても、
  // 関連度スコア中心の既存selectEvidence()がPortal/一覧ページを
  // 優先してしまい最終Evidenceから漏れることを確認した)
  // ==========================================================

  {
    // Test1: 個別Entity EvidenceがPortal Evidenceに不当に負けない。
    // 既存selectEvidence()の関連度順(Phase98実データを模した並び:
    // Portal 3件が上位、個別Entityらしい行政プログラムが末尾)を入力とし、
    // limitを3件にした場合でも、個別Entityが押し出されず残ることを確認する。
    const rankedWithPortalFirst: Evidence[] = [
      makeEvidence({
        id: "portal-1",
        claim: "愛知県で実施 - インターンシップ・キャリア情報一覧 | キャリタス就活",
        source: "https://job.career-tasu.jp/intern-search/lst-isArea-04/lst-isPref-23/",
      }),
      makeEvidence({
        id: "portal-2",
        claim: "愛知県のインターンシップ一覧｜就活イベントを探すなら【ONE CAREER】",
        source: "https://www.onecareer.jp/events/internship/area/4/23",
      }),
      makeEvidence({
        id: "portal-3",
        claim: "愛知県のインターン・インターンシップ（2212件）",
        source: "https://internshipguide.jp/interns/japanInternList/23",
      }),
      makeEvidence({
        id: "individual-1",
        claim: "2025年度 愛知県「留学生地域定着・活躍促進事業」留学生インターンシップ（夏季）について",
        source: "https://www.pref.aichi.jp/some-program-page.html",
        evidence: "開催日: 2025年8月、対象: 大学3〜4年生、参加費: 無料。",
      }),
    ];

    const prioritized = prioritizeIndividualEntityEvidence(rankedWithPortalFirst, 3);

    results.push(
      check(
        "[Phase99-1] 個別Entity Evidence(行政プログラム)がPortal Evidence 3件より" +
          "関連度順で後ろにあっても、limit=3の最終選定で残る(Portalに不当に負けない)",
        prioritized.some((item) => item.id === "individual-1"),
        `prioritized=${JSON.stringify(prioritized.map((item) => item.id))}`
      )
    );

    results.push(
      check(
        "[Phase99-1-2] 個別Entity Evidenceが先頭(最優先)に来る" +
          "(Individual/Portalそれぞれのグループ内では元の関連度順を維持したまま、" +
          "Individualグループを先に並べる設計の確認)",
        prioritized[0]?.id === "individual-1"
      )
    );

  }

  {
    // Test2: Portal Evidenceしか存在しない場合、Portal Evidenceを引き続き
    // 利用できる(全面排除しない)。件数・順序とも変化しないことを確認する。
    const portalOnly: Evidence[] = [
      makeEvidence({
        id: "portal-1",
        claim: "愛知県のインターンシップ一覧｜就活イベントを探すなら【ONE CAREER】",
        source: "https://www.onecareer.jp/events/internship/area/4/23",
      }),
      makeEvidence({
        id: "portal-2",
        claim: "愛知県のインターン・インターンシップ（1034件）",
        source: "https://internshipguide.jp/interns/japanInternList/23",
      }),
    ];

    const prioritized = prioritizeIndividualEntityEvidence(portalOnly, 10);

    results.push(
      check(
        "[Phase99-2] Individual Entityが1件も無い場合、Portal Evidenceが" +
          "そのまま(件数・順序を変えず)最終選定に残る(Portal Evidenceの全面排除禁止)",
        prioritized.length === 2 &&
          prioritized[0].id === "portal-1" &&
          prioritized[1].id === "portal-2",
        `prioritized=${JSON.stringify(prioritized.map((item) => item.id))}`
      )
    );

  }

  {
    // Test3: 個別EntityとPortalが混在する場合、limitに達するまでは
    // Individualグループを使い切ってからPortalで埋める。
    const mixed: Evidence[] = [
      makeEvidence({ id: "portal-1", claim: "◯◯県のインターン一覧", source: "https://example.com/a" }),
      makeEvidence({
        id: "individual-1",
        claim: "株式会社サンプルA 1dayインターンシップ 8月20日開催",
        source: "https://example.com/sample-a",
      }),
      makeEvidence({ id: "portal-2", claim: "◯◯のインターンシップ情報", source: "https://example.com/b" }),
      makeEvidence({
        id: "individual-2",
        claim: "株式会社サンプルB 説明会 9月1日開催",
        source: "https://example.com/sample-b",
      }),
    ];

    const prioritized = prioritizeIndividualEntityEvidence(mixed, 3);

    results.push(
      check(
        "[Phase99-3] 個別Entity 2件がPortal 2件より先に並び、limit=3の3件目だけ" +
          "Portalで埋まる(Individualを使い切ってからPortalで補う設計の確認)",
        JSON.stringify(prioritized.map((item) => item.id)) ===
          JSON.stringify(["individual-1", "individual-2", "portal-1"]),
        `prioritized=${JSON.stringify(prioritized.map((item) => item.id))}`
      )
    );

  }

  {
    // Test4: Evidence自体の内容(claim/evidence本文/confidence等)は
    // 一切変更しない(並び替えのみ、捏造・断定的な補完をしない)。
    const original = makeEvidence({
      id: "individual-1",
      claim: "株式会社サンプルC インターン",
      source: "https://example.com/sample-c",
      evidence: "詳細は未確認。",
      confidence: "low",
    });

    const [result] = prioritizeIndividualEntityEvidence([original], 10);

    results.push(
      check(
        "[Phase99-4] 弱いEvidence(confidence='low'、本文が薄い)であっても、内容を書き換えたり" +
          "confidenceを引き上げたりしない(並び替えのみ、無理にEntityの確からしさを補強しない)",
        result?.claim === original.claim &&
          result?.evidence === original.evidence &&
          result?.confidence === "low" &&
          result?.source === original.source
      )
    );

  }

  {
    // Test5: No-Fabrication / Grounding境界の確認。
    // prioritizeIndividualEntityEvidence()はEvidence[]の並び替えのみを行い、
    // groundParsedEntities()(tact-conversation層、Phase83、無変更)が
    // 要求する「Entity title/fieldがEvidence本文に文字列として存在する
    // こと」というRuleには一切関与しない。ここでは、本関数の出力が
    // 引き続き通常のResearchEvidenceItem生成経路(runResearch.tsの
        // toResearchEvidenceItems())へそのまま渡せる形(Evidence[]、新しい
    // フィールドを追加していない)であることを確認する。
    const evidence: Evidence[] = [
      makeEvidence({ id: "e1", claim: "架空判定用サンプル", source: "https://example.com/x" }),
    ];

    const prioritized = prioritizeIndividualEntityEvidence(evidence, 10);
    const keys = Object.keys(prioritized[0] ?? {}).sort();
    const originalKeys = Object.keys(evidence[0]).sort();

    results.push(
      check(
        "[Phase99-5] 出力はEvidence型のフィールド構成を変えない" +
          "(新しいフィールドを追加せず、既存のGrounding/toResearchEvidenceItems()が" +
          "そのまま消費できる形を維持する)",
        JSON.stringify(keys) === JSON.stringify(originalKeys),
        `keys=${JSON.stringify(keys)}`
      )
    );

  }

  return summarize("discovery-deepening-candidate-extraction (Phase 93)", results);

}
