// =========================
// TACT Context Source — Local Workspace Context Resolver Regression
// (LW-P3, pure functions)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/resolver.ts
// (detectExplicitWorkspaceIntent・extractWorkspaceQueryTerms・
// rankWorkspaceCandidates・selectFilesWithinReadLimit・
// boundWorkspaceEvidenceByCharBudget)。
//
// 環境制約: DOM/IndexedDB/File System Access APIは一切使わない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。
// adapter経由の統合(実際にfileを読む部分)はcontextSource/
// workspaceResolverAdapter.test.tsで確認する。

import "dotenv/config";
import {
  MAX_WORKSPACE_READ_FILES,
  MAX_WORKSPACE_SEARCH_CANDIDATES,
  MAX_WORKSPACE_TOTAL_CONTEXT_CHARS,
  boundWorkspaceEvidenceByCharBudget,
  detectExplicitWorkspaceIntent,
  extractWorkspaceQueryTerms,
  rankWorkspaceCandidates,
  selectFilesWithinReadLimit,
} from "../../../core/tact-context-source/localWorkspace/resolver";
import type { LocalWorkspaceContentIndex } from "../../../core/tact-context-source/localWorkspace/contentIndex";
import type { LocalWorkspaceEvidence } from "../../../core/tact-context-source/localWorkspace/types";
import type { ContextSourceEntryMetadata } from "../../../core/tact-context-source/types";
import { check, summarize, type CheckResult } from "../lib/check";

function fileEntry(overrides: Partial<ContextSourceEntryMetadata>): ContextSourceEntryMetadata {
  return {
    name: "file.txt",
    relativePath: "file.txt",
    type: "file",
    extension: "txt",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Explicit workspace intent
  // ==========================================================

  const explicitIntentCases = [
    "ローカル資料を参考に、地域スポーツ活動の社会的価値について調査して",
    "Workspaceから探して",
    "前に作ったSROI資料を使って",
    "PC内の資料を参考に",
  ];

  for (const query of explicitIntentCases) {
    results.push(
      check(
        `[Test1] 「${query}」は明示的なWorkspace参照意図としてtrue`,
        detectExplicitWorkspaceIntent(query) === true
      )
    );
  }

  results.push(
    check(
      "[Test2] 「トヨタについて調べて」のような通常Researchはfalse(無条件にWorkspaceを使わない)",
      detectExplicitWorkspaceIntent("トヨタについて調べて") === false
    )
  );

  results.push(
    check(
      "[Test2-2] 空文字・空白のみもfalse",
      detectExplicitWorkspaceIntent("") === false && detectExplicitWorkspaceIntent("   ") === false
    )
  );

  // ==========================================================
  // Query term extraction: ASCII固有名詞(SROI)が日本語文中でも
  // 独立したtermとして抽出される
  // ==========================================================

  {
    const terms = extractWorkspaceQueryTerms(
      "ローカルのSROI資料を参考に、地域スポーツ活動の社会的価値について調査して"
    );

    results.push(
      check(
        "[Test3-1] 区切り文字が無い日本語文中のASCII固有名詞(SROI)も独立したtermとして抽出される",
        terms.includes("sroi")
      )
    );

    results.push(
      check(
        "[Test3-2] termは小文字化される",
        !terms.includes("SROI") && terms.includes("sroi")
      )
    );

  }

  results.push(
    check(
      "[Test3-3] 空文字queryは空配列を返す",
      extractWorkspaceQueryTerms("").length === 0
    )
  );

  {
    const manyTermsQuery = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
    const terms = extractWorkspaceQueryTerms(manyTermsQuery);

    results.push(
      check(
        "[Test3-4] term数はmaxTerms(既定値)を超えない",
        terms.length <= 8
      )
    );
  }

  // ==========================================================
  // Ranking: SROI query -> 関連fileを発見、無関係fileは除外、決定論的
  // ==========================================================

  const entries: ContextSourceEntryMetadata[] = [
    fileEntry({ name: "memo.txt", relativePath: "memo.txt", extension: "txt" }),
    fileEntry({ name: "research.md", relativePath: "research.md", extension: "md" }),
    fileEntry({ name: "readme.md", relativePath: "readme.md", extension: "md" }),
    fileEntry({ name: "sroi-plan.md", relativePath: "docs/sroi-plan.md", extension: "md" }),
    { name: "src", relativePath: "src", type: "directory" },
  ];

  const contentIndex: LocalWorkspaceContentIndex = [
    { relativePath: "memo.txt", contentLower: "this project measures sroi for the community program." },
    { relativePath: "research.md", contentLower: "# research\nsroi methodology overview." },
    { relativePath: "readme.md", contentLower: "# hello world" },
  ];

  const terms = extractWorkspaceQueryTerms("SROIの資料を教えて");

  {
    const ranked = rankWorkspaceCandidates(entries, contentIndex, terms);
    const rankedPaths = ranked.map((r) => r.entry.relativePath);

    results.push(
      check(
        "[Test4-1] SROI query -> content一致のmemo.txt/research.mdが候補になる",
        rankedPaths.includes("memo.txt") && rankedPaths.includes("research.md")
      )
    );

    results.push(
      check(
        "[Test4-2] filename一致のdocs/sroi-plan.mdも候補になる(metadata一致)",
        rankedPaths.includes("docs/sroi-plan.md")
      )
    );

    results.push(
      check(
        "[Test4-3] 無関係なfile(readme.md)・directory(src)は候補から除外される",
        !rankedPaths.includes("readme.md") && !rankedPaths.some((p) => p === "src")
      )
    );

    results.push(
      check(
        "[Test4-4] filename一致(重み2倍)のfileがcontentのみ一致のfileより上位に来る",
        ranked[0].entry.relativePath === "docs/sroi-plan.md"
      )
    );

    const rankedAgain = rankWorkspaceCandidates(entries, contentIndex, terms);

    results.push(
      check(
        "[Test4-5] rankingは決定論的(同じ入力なら常に同じ順序)",
        JSON.stringify(ranked.map((r) => r.entry.relativePath)) ===
          JSON.stringify(rankedAgain.map((r) => r.entry.relativePath))
      )
    );

  }

  results.push(
    check(
      "[Test4-6] termが空の場合は空配列を返す(0件で安全に停止)",
      rankWorkspaceCandidates(entries, contentIndex, []).length === 0
    )
  );

  // ==========================================================
  // Bounded retrieval: max候補件数
  // ==========================================================

  {
    const manyEntries: ContextSourceEntryMetadata[] = Array.from({ length: 50 }, (_, i) =>
      fileEntry({ name: `sroi-${i}.txt`, relativePath: `sroi-${i}.txt`, extension: "txt" })
    );

    const ranked = rankWorkspaceCandidates(manyEntries, [], ["sroi"]);

    results.push(
      check(
        `[Test5-1] 候補件数はMAX_WORKSPACE_SEARCH_CANDIDATES(${MAX_WORKSPACE_SEARCH_CANDIDATES})を超えない`,
        ranked.length === MAX_WORKSPACE_SEARCH_CANDIDATES
      )
    );

  }

  // ==========================================================
  // Bounded retrieval: max read files
  // ==========================================================

  {
    const ranked = rankWorkspaceCandidates(
      Array.from({ length: 10 }, (_, i) => fileEntry({ name: `sroi-${i}.txt`, relativePath: `sroi-${i}.txt` })),
      [],
      ["sroi"]
    );

    const selected = selectFilesWithinReadLimit(ranked);

    results.push(
      check(
        `[Test6-1] read対象はMAX_WORKSPACE_READ_FILES(${MAX_WORKSPACE_READ_FILES})を超えない`,
        selected.length === MAX_WORKSPACE_READ_FILES
      )
    );

  }

  // ==========================================================
  // Bounded retrieval: total context chars上限
  // ==========================================================

  function makeEvidence(relativePath: string, contentLength: number): LocalWorkspaceEvidence {
    return {
      evidence: {
        id: `local_workspace:ws:${relativePath}`,
        claim: relativePath,
        evidence: "x".repeat(contentLength),
        source: `local-workspace://ws/${relativePath}`,
        sourceType: "user_file",
        confidence: "medium",
        score: 0,
        createdBy: "local-workspace-context-source",
        createdAt: Date.now(),
        tags: ["local_workspace", "user_file"],
        references: [],
      },
      provenance: {
        sourceType: "local_workspace",
        workspaceId: "ws",
        relativePath,
        fileName: relativePath,
      },
    };
  }

  {
    const evidenceList = [
      makeEvidence("a.txt", 30_000),
      makeEvidence("b.txt", 30_000),
      makeEvidence("c.txt", 1_000),
    ];

    const bounded = boundWorkspaceEvidenceByCharBudget(evidenceList);
    const totalChars = bounded.reduce((sum, item) => sum + item.evidence.evidence.length, 0);

    results.push(
      check(
        `[Test7-1] 合計文字数はMAX_WORKSPACE_TOTAL_CONTEXT_CHARS(${MAX_WORKSPACE_TOTAL_CONTEXT_CHARS})を超えない`,
        totalChars <= MAX_WORKSPACE_TOTAL_CONTEXT_CHARS
      )
    );

    results.push(
      check(
        "[Test7-2] 予算超過するfile(2番目のb.txt)は丸ごと除外され、後続の小さいfile(c.txt)は予算内なら含まれる",
        bounded.some((item) => item.provenance.relativePath === "a.txt") &&
          !bounded.some((item) => item.provenance.relativePath === "b.txt") &&
          bounded.some((item) => item.provenance.relativePath === "c.txt")
      )
    );

  }

  results.push(
    check(
      "[Test7-3] 空配列を渡しても例外を投げず空配列を返す(0件で安全に継続)",
      boundWorkspaceEvidenceByCharBudget([]).length === 0
    )
  );

  return summarize("contextSource/resolver", results);

}
