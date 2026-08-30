// =========================
// TACT Research — Local Workspace Mock E2E Preview (development専用)
// =========================
//
// 目的: 実Browser Local Workspace接続・実LLM・実Search API・実Supabase
// writeを一切使わずに、LW-P3のWorkspace Context Resolution
// (core/tact-context-source/localWorkspace/resolver.ts等)から
// Research Context Assembly(core/tact-research/contextAssembly.ts)
// までの一連の流れを、development専用のUIで確認できるようにする。
//
// 重要: ここで新しいranking/matching/context assemblyロジックは
// 一切実装しない。LW-P3の本番pure functionをそのまま呼び出し、
// 「実Browser File System Access APIの代わりに、静的なmock file配列を
// データsourceとして使う」というglue部分のみをここで書く
// (core/tact-context-source/localWorkspace/browserAdapter.tsの
// resolveWorkspaceContext()と同じ処理順序を、同じ本番関数群で再現する。
// FileSystemDirectoryHandleへのアクセスだけをmock dataへ差し替える)。
//
// production disabled: getLocalWorkspacePreviewKind()はdevelopment以外
// では常にnullを返す(components/research/artifactPreview.tsの
// getArtifactPreview()と同じgating pattern)。

import type { CoreContext } from "@/core/tact-core";
import type {
  ContextSourceEntryMetadata,
  ContextSourceReadResult,
} from "@/core/tact-context-source/types";
import {
  buildContentIndexEntry,
  isIndexableEntry,
  type LocalWorkspaceContentIndex,
} from "@/core/tact-context-source/localWorkspace/contentIndex";
import {
  isSupportedReadExtension,
  truncateReadContent,
} from "@/core/tact-context-source/localWorkspace/readPolicy";
import {
  boundWorkspaceEvidenceByCharBudget,
  detectExplicitWorkspaceIntent,
  detectWorkspaceOptOut,
  extractWorkspaceQueryTerms,
  rankWorkspaceCandidates,
  selectFilesWithinReadLimit,
} from "@/core/tact-context-source/localWorkspace/resolver";
import { contextSourceReadResultToEvidence } from "@/core/tact-context-source/localWorkspace/toEvidence";
import type { LocalWorkspaceEvidence } from "@/core/tact-context-source/localWorkspace/types";
import { assembleResearchContext } from "@/core/tact-research/contextAssembly";

// =========================
// Mock fixtures
// =========================

export const LOCAL_WORKSPACE_PREVIEW_KINDS = ["research"] as const;
export type LocalWorkspacePreviewKind = (typeof LOCAL_WORKSPACE_PREVIEW_KINDS)[number];

export const LOCAL_WORKSPACE_PREVIEW_WORKSPACE_ID = "preview-workspace-tact-workspace-test";

export interface LocalWorkspacePreviewMockFile {
  relativePath: string;
  content: string;
  modifiedAt?: string;
}

export const DEFAULT_MOCK_WORKSPACE_FILES: readonly LocalWorkspacePreviewMockFile[] = [
  {
    relativePath: "research.md",
    content: "# SROI研究\n地域スポーツ活動の社会的価値について調査する。",
    modifiedAt: "2026-08-20T00:00:00.000Z",
  },
  {
    relativePath: "memo.txt",
    content: "これはTACT Local Workspaceのテストファイルです。\nSROIについて調査しています。",
    modifiedAt: "2026-08-21T00:00:00.000Z",
  },
  {
    relativePath: "sample.csv",
    content: "year,value\n2023,100\n2024,120\n2025,150",
    modifiedAt: "2026-08-22T00:00:00.000Z",
  },
];

export const DEFAULT_MOCK_QUERY =
  "前に作ったSROI研究の資料を参考に、地域スポーツ活動の社会的価値について調査して";

// =========================
// Result shape (UI表示用)
// =========================

export interface LocalWorkspacePreviewCandidate {
  relativePath: string;
  name: string;
  extension?: string;
  score: number;
  metadataMatchCount: number;
  contentMatchCount: number;
  // read対象(MAX_WORKSPACE_READ_FILES以内)として選ばれたかどうか。
  read: boolean;
}

export interface LocalWorkspacePreviewReadFile {
  relativePath: string;
  contentChars: number;
  truncated: boolean;
  // 合計文字数上限(boundWorkspaceEvidenceByCharBudget)により、最終
  // context blockから除外された場合はfalse。
  includedInContext: boolean;
}

export type LocalWorkspacePreviewReason =
  | "opted_out"
  | "no_intent"
  | "no_candidates"
  | "used";

export interface LocalWorkspacePreviewResult {
  query: string;
  optedOut: boolean;
  intentDetected: boolean;
  used: boolean;
  reason: LocalWorkspacePreviewReason;
  terms: string[];
  candidates: LocalWorkspacePreviewCandidate[];
  readFiles: LocalWorkspacePreviewReadFile[];
  totalContextChars: number;
  evidence: LocalWorkspaceEvidence[];
  workspaceEvidenceBlock?: string;
  userPrompt: string;
  systemPrompt: string;
}

// =========================
// mock file <-> ContextSourceEntryMetadata変換(walkEntries()相当)
// =========================

function extractExtension(name: string): string | undefined {

  const lastDot = name.lastIndexOf(".");

  if (lastDot <= 0 || lastDot === name.length - 1) {
    return undefined;
  }

  return name.slice(lastDot + 1).toLowerCase();

}

function toEntryMetadata(file: LocalWorkspacePreviewMockFile): ContextSourceEntryMetadata {

  const segments = file.relativePath.split("/").filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1] ?? file.relativePath;

  return {
    name,
    relativePath: file.relativePath,
    type: "file",
    size: file.content.length,
    modifiedAt: file.modifiedAt,
    extension: extractExtension(name),
  };

}

// mockファイルをContextSourceReadResultへ変換する(browserAdapter.tsの
// performSafeRead()相当)。実際のpermission/directory判定は
// FileSystemHandleへの依存があるためmockでは行わないが、対応拡張子
// 判定(isSupportedReadExtension)とtruncation(truncateReadContent)は
// 本番と同じpure functionをそのまま使う。
function mockRead(
  file: LocalWorkspacePreviewMockFile,
  entry: ContextSourceEntryMetadata
): ContextSourceReadResult | null {

  if (!isSupportedReadExtension(entry.extension)) {
    return null;
  }

  const { content, truncated } = truncateReadContent(file.content);

  return { entry, content, truncated };

}

const emptyCoreContext = (): CoreContext => ({
  knowledge: [],
  memories: [],
  examples: [],
  recentExecutions: [],
});

// contextAssembly.ts側の見出し文字列と一致させる(表示用の抽出のみ、
// ロジックの複製ではない)。
const WORKSPACE_BLOCK_HEADING = "Local Workspace Evidence";

function extractWorkspaceBlock(userPrompt: string): string | undefined {

  const index = userPrompt.indexOf(WORKSPACE_BLOCK_HEADING);

  return index === -1 ? undefined : userPrompt.slice(index).trim();

}

function assembleWithoutWorkspace(query: string): { userPrompt: string; systemPrompt: string } {

  const assembled = assembleResearchContext({
    query,
    context: emptyCoreContext(),
    evidence: [],
    requirements: [],
  });

  return { userPrompt: assembled.userPrompt, systemPrompt: assembled.systemPrompt };

}

// =========================
// runLocalWorkspacePreview
// =========================
//
// core/tact-context-source/localWorkspace/browserAdapter.tsの
// resolveWorkspaceContext()と同じ処理順序(opt-out判定→intent判定→
// term抽出→metadata/content index→ranking→bounded read→
// Evidence変換→char budget)をmock dataで再現し、最後に本番の
// assembleResearchContext()を呼んでResearchへ渡る実際のcontext block
// まで確認できるようにする。LLM/Search API呼び出しは一切無い。
export function runLocalWorkspacePreview(
  query: string,
  mockFiles: readonly LocalWorkspacePreviewMockFile[] = DEFAULT_MOCK_WORKSPACE_FILES,
  workspaceId: string = LOCAL_WORKSPACE_PREVIEW_WORKSPACE_ID
): LocalWorkspacePreviewResult {

  const optedOut = detectWorkspaceOptOut(query);
  const intentDetected = detectExplicitWorkspaceIntent(query);

  const base = {
    query,
    optedOut,
    intentDetected,
    candidates: [] as LocalWorkspacePreviewCandidate[],
    readFiles: [] as LocalWorkspacePreviewReadFile[],
    totalContextChars: 0,
    evidence: [] as LocalWorkspaceEvidence[],
    workspaceEvidenceBlock: undefined as string | undefined,
  };

  // opt-outはintent判定より優先する(resolveWorkspaceContext()と同じ順序)。
  if (optedOut) {
    return { ...base, used: false, reason: "opted_out", terms: [], ...assembleWithoutWorkspace(query) };
  }

  if (!intentDetected) {
    return { ...base, used: false, reason: "no_intent", terms: [], ...assembleWithoutWorkspace(query) };
  }

  const terms = extractWorkspaceQueryTerms(query);

  const entries = mockFiles.map(toEntryMetadata);
  const contentIndex: LocalWorkspaceContentIndex = [];

  for (const entry of entries) {

    if (!isIndexableEntry(entry)) {
      continue;
    }

    const file = mockFiles.find((candidate) => candidate.relativePath === entry.relativePath);

    if (!file) {
      continue;
    }

    contentIndex.push(buildContentIndexEntry(entry.relativePath, file.content));

  }

  const ranked = rankWorkspaceCandidates(entries, contentIndex, terms);

  if (ranked.length === 0) {
    return { ...base, used: false, reason: "no_candidates", terms, ...assembleWithoutWorkspace(query) };
  }

  const toRead = selectFilesWithinReadLimit(ranked);
  const toReadPaths = new Set(toRead.map((candidate) => candidate.entry.relativePath));

  const candidates: LocalWorkspacePreviewCandidate[] = ranked.map((candidate) => ({
    relativePath: candidate.entry.relativePath,
    name: candidate.entry.name,
    extension: candidate.entry.extension,
    score: candidate.score,
    metadataMatchCount: candidate.metadataMatchCount,
    contentMatchCount: candidate.contentMatchCount,
    read: toReadPaths.has(candidate.entry.relativePath),
  }));

  const rawEvidence: LocalWorkspaceEvidence[] = [];
  const readFilesByPath = new Map<string, LocalWorkspacePreviewReadFile>();

  for (const candidate of toRead) {

    const file = mockFiles.find((entry) => entry.relativePath === candidate.entry.relativePath);

    if (!file) {
      continue;
    }

    const result = mockRead(file, candidate.entry);

    if (!result) {
      continue;
    }

    rawEvidence.push(contextSourceReadResultToEvidence(workspaceId, result));

    readFilesByPath.set(candidate.entry.relativePath, {
      relativePath: candidate.entry.relativePath,
      contentChars: result.content.length,
      truncated: result.truncated,
      includedInContext: false,
    });

  }

  const bounded = boundWorkspaceEvidenceByCharBudget(rawEvidence);
  const boundedPaths = new Set(bounded.map((item) => item.provenance.relativePath));

  for (const path of boundedPaths) {
    const entry = readFilesByPath.get(path);
    if (entry) {
      entry.includedInContext = true;
    }
  }

  const totalContextChars = bounded.reduce((sum, item) => sum + item.evidence.evidence.length, 0);

  const assembled = assembleResearchContext({
    query,
    context: emptyCoreContext(),
    evidence: [],
    requirements: [],
    workspaceEvidence: bounded,
  });

  return {
    ...base,
    used: bounded.length > 0,
    reason: bounded.length > 0 ? "used" : "no_candidates",
    terms,
    candidates,
    readFiles: Array.from(readFilesByPath.values()),
    totalContextChars,
    evidence: bounded,
    workspaceEvidenceBlock: extractWorkspaceBlock(assembled.userPrompt),
    userPrompt: assembled.userPrompt,
    systemPrompt: assembled.systemPrompt,
  };

}

// =========================
// URL query param gating (development専用)
// =========================

function isLocalWorkspacePreviewKind(
  value: string | null | undefined
): value is LocalWorkspacePreviewKind {
  return typeof value === "string" && (LOCAL_WORKSPACE_PREVIEW_KINDS as readonly string[]).includes(value);
}

/**
 * Development-only, pure query lookup. production環境では常にnullを
 * 返す(components/research/artifactPreview.tsのgetArtifactPreview()と
 * 同じgating pattern)。
 */
export function getLocalWorkspacePreviewKind(
  value: string | null | undefined,
  environment = process.env.NODE_ENV
): LocalWorkspacePreviewKind | null {

  if (environment !== "development" || !isLocalWorkspacePreviewKind(value)) {
    return null;
  }

  return value;

}
