import type { Artifact, ArtifactBlock, ChartBlock, TableBlock } from "@/core/tact-artifact/types";
import type { ArtifactEvidenceSource } from "./ArtifactEvidencePopover";

export const ARTIFACT_PREVIEW_KINDS = ["table", "line", "bar", "cagr", "swot", "analysis"] as const;
export type ArtifactPreviewKind = (typeof ARTIFACT_PREVIEW_KINDS)[number];

const TIMESTAMP = "2026-08-29T00:00:00.000Z";

function table(
  id: string,
  title: string,
  order: number,
  columns: string[],
  rows: string[][],
  sourceEvidenceIds: string[],
): TableBlock {
  return {
    id,
    type: "table",
    title,
    order,
    columns,
    rows,
    sourceEvidenceIds,
    rowSourceEvidenceIds: rows.map((_, index) => [sourceEvidenceIds[index] ?? sourceEvidenceIds[0] ?? "preview-evidence"]),
    cellSourceEvidenceIds: rows.map((row, index) => row.map(() => [sourceEvidenceIds[index] ?? sourceEvidenceIds[0] ?? "preview-evidence"])),
    tablePurpose: "comparison",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function chart(id: string, title: string, order: number, chartType: ChartBlock["chartType"], data: ChartBlock["data"], sourceEvidenceIds: string[]): ChartBlock {
  return {
    id,
    type: "chart",
    title,
    order,
    chartType,
    data,
    sourceEvidenceIds,
    pointSourceEvidenceIds: data.map((_, index) => [sourceEvidenceIds[index] ?? sourceEvidenceIds[0] ?? "preview-evidence"]),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function artifact(id: string, title: string, blocks: ArtifactBlock[]): Artifact {
  return {
    id,
    userId: "development-preview",
    title,
    blocks,
    content: "Development-only Artifact preview fixture. No Research or provider call was made.",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const revenueComparison = table(
  "preview-table-revenue-comparison",
  "トヨタ・ホンダ売上比較（長い表示タイトルの確認用）",
  0,
  ["企業", "年度", "指標", "売上高"],
  [["トヨタ", "2024", "売上高", "45.1兆円"], ["ホンダ", "2024", "売上高", "21.7兆円"]],
  ["preview-toyota-2024", "preview-honda-2024"],
);

const revenueLine = chart(
  "preview-line-toyota-revenue",
  "トヨタ売上推移",
  0,
  "line",
  [{ label: "2022", value: 37.2 }, { label: "2023", value: 43.0 }, { label: "2024", value: 45.1 }, { label: "2025", value: 48.0 }],
  ["preview-toyota-2022", "preview-toyota-2023", "preview-toyota-2024", "preview-toyota-2025"],
);

const revenueBar = chart(
  "preview-bar-revenue-comparison",
  "2024年 売上比較",
  0,
  "bar",
  [{ label: "トヨタ", value: 45.1 }, { label: "ホンダ", value: 21.7 }],
  ["preview-toyota-2024", "preview-honda-2024"],
);

const cagr = table(
  "preview-calculation-cagr",
  "CAGR",
  0,
  ["Metric", "Display", "Raw", "Formula"],
  [["CAGR", "10.1%", "0.101", "(end/start)^(1/periods)-1"]],
  ["preview-toyota-2022", "preview-toyota-2024"],
);

const swot = table(
  "preview-framework-swot",
  "SWOT分析",
  0,
  ["Section", "Kind", "Content", "Evidence"],
  [
    ["Strength", "Fact", "高い販売規模を維持している", "preview-toyota-2024"],
    ["Weakness", "Fact", "一部市場での競争が激しい", "preview-market-competition"],
    ["Opportunity", "Inference", "電動化需要が成長機会となる可能性", "preview-ev-demand"],
    ["Threat", "Fact", "原材料価格の変動リスクがある", "preview-material-cost"],
  ],
  ["preview-toyota-2024", "preview-market-competition", "preview-ev-demand", "preview-material-cost"],
);

const fixtures: Record<ArtifactPreviewKind, Artifact> = {
  table: artifact("preview-artifact-table", "開発プレビュー · 売上比較表", [revenueComparison]),
  line: artifact("preview-artifact-line", "開発プレビュー · 折れ線グラフ", [revenueLine]),
  bar: artifact("preview-artifact-bar", "開発プレビュー · 棒グラフ", [revenueBar]),
  cagr: artifact("preview-artifact-cagr", "開発プレビュー · CAGR", [cagr]),
  swot: artifact("preview-artifact-swot", "開発プレビュー · SWOT", [swot]),
  analysis: artifact("preview-artifact-analysis", "開発プレビュー · トヨタ売上分析", [
    { ...revenueLine, order: 0 },
    { ...cagr, order: 1 },
    { ...swot, order: 2 },
  ]),
};

// Preview-only source metadata. These labels and example.com links are clearly
// marked as mock data and are never persisted with an Artifact.
const previewEvidenceSources: Record<string, ArtifactEvidenceSource> = Object.fromEntries([
  "preview-toyota-2022",
  "preview-toyota-2023",
  "preview-toyota-2024",
  "preview-toyota-2025",
  "preview-honda-2024",
  "preview-market-competition",
  "preview-ev-demand",
  "preview-material-cost",
].map((id) => [id, {
  id,
  title: `開発用モック出典（${id.replace("preview-", "")}）`,
  url: `https://example.com/#${id}`,
}]));

function isArtifactPreviewKind(value: string | null | undefined): value is ArtifactPreviewKind {
  return typeof value === "string" && (ARTIFACT_PREVIEW_KINDS as readonly string[]).includes(value);
}

/**
 * Development-only, pure fixture lookup. It performs no fetch, persistence,
 * Cortex execution, or provider work; production always returns null.
 */
export function getArtifactPreview(value: string | null | undefined, environment = process.env.NODE_ENV): Artifact | null {
  if (environment !== "development" || !isArtifactPreviewKind(value)) return null;
  // useSyncExternalStore requires Object.is(getSnapshot(), getSnapshot()) for
  // an unchanged source. These module-scope fixtures are read-only preview
  // inputs: the Workspace renderer never mutates the Artifact or its blocks.
  return fixtures[value];
}

/** Preview-only metadata for exercising the existing provenance UI. */
export function getArtifactPreviewEvidenceSources(artifactId: string): Readonly<Record<string, ArtifactEvidenceSource>> {
  return artifactId.startsWith("preview-artifact-") ? previewEvidenceSources : {};
}
