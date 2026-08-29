import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computePopoverPosition, selectArtifactEvidenceSources } from "../../../components/research/ArtifactEvidencePopover";
import { ARTIFACT_PREVIEW_KINDS, getArtifactPreview, getArtifactPreviewEvidenceSources } from "../../../components/research/artifactPreview";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const previews = ARTIFACT_PREVIEW_KINDS.map((kind) => getArtifactPreview(kind, "development"));

  results.push(check("[Preview] development lookup returns every declared fixture", previews.every((preview) => preview !== null) && previews.length === 6));
  results.push(check("[Preview] table fixture uses the existing TableBlock schema with cell provenance", previews[0]?.blocks[0]?.type === "table" && previews[0].blocks[0].cellSourceEvidenceIds?.[0]?.[0]?.[0] === "preview-toyota-2024"));
  results.push(check("[Preview] line and bar fixtures use existing ChartBlock types", previews[1]?.blocks[0]?.type === "chart" && previews[1].blocks[0].chartType === "line" && previews[2]?.blocks[0]?.type === "chart" && previews[2].blocks[0].chartType === "bar"));
  results.push(check("[Preview] CAGR and SWOT remain existing TableBlocks", previews[3]?.blocks[0]?.type === "table" && previews[4]?.blocks[0]?.type === "table" && previews[4].blocks[0].rows.length === 4));
  results.push(check("[Preview] combined analysis fixture has stable multi-block ordering", previews[5]?.blocks.map((block) => block.order).join(",") === "0,1,2"));
  results.push(check("[Preview] unchanged lookup returns the same cached fixture reference for useSyncExternalStore", getArtifactPreview("table", "development") === getArtifactPreview("table", "development") && getArtifactPreview("analysis", "development") === getArtifactPreview("analysis", "development")));
  results.push(check("[Preview] unknown query is safe and returns no Artifact", getArtifactPreview("unknown", "development") === null));
  results.push(check("[Preview] production disables every preview query", ARTIFACT_PREVIEW_KINDS.every((kind) => getArtifactPreview(kind, "production") === null)));
  const previewSources = getArtifactPreviewEvidenceSources("preview-artifact-analysis");
  const resolvedSources = selectArtifactEvidenceSources(
    ["preview-toyota-2024", "preview-toyota-2024", "preview-honda-2024"],
    previewSources,
  );
  results.push(check("[Preview] evidence popover uses declared mock title/URL metadata and deduplicates source IDs", resolvedSources.length === 2 && resolvedSources.every((source) => source.title?.startsWith("開発用モック出典") && source.url?.startsWith("https://example.com/#preview-"))));

  const fixtureSource = readFileSync("components/research/artifactPreview.ts", "utf8");
  const workspaceSource = readFileSync("components/research/ResearchWorkspace.tsx", "utf8");
  results.push(check("[Preview] fixture lookup is pure: it has no network, provider, or Cortex execution dependency", !fixtureSource.includes("fetch(") && !fixtureSource.includes("runCortex") && !fixtureSource.includes("runLLM")));
  results.push(check("[Preview] Workspace resolves the preview before normal loading and blocks preview-side API mutations", workspaceSource.includes("getArtifactPreview(new URLSearchParams(window.location.search).get(\"artifactPreview\"))") && workspaceSource.includes("if (artifactPreviewActive || !user)") && workspaceSource.includes("if (artifactPreviewActive) {\n      return;\n    }")));
  results.push(check("[Preview] polished Artifact rendering uses the shared evidence popover and keeps copy output free of internal table columns", workspaceSource.includes("<ArtifactEvidencePopover") && workspaceSource.includes("isInternalArtifactColumn") && workspaceSource.includes("getArtifactTableView")));

  // Bug fix regression: the line chart used to render a y-axis max/min <text> label
  // (e.g. "48") pinned near the top-left in addition to each point's own value label,
  // which visually overlapped the first point's label. Only the per-point value
  // label should remain, so each value renders exactly once next to its own point.
  const lineChartSource = workspaceSource.slice(workspaceSource.indexOf("function LineChart"), workspaceSource.indexOf("function LoadingIndicator"));
  results.push(check("[LineChart] no separate y-axis max/min label remains (removes the extra top-left value that overlapped the first point)", !lineChartSource.includes("{maximum}</text>") && !lineChartSource.includes("{minimum}</text>")));
  results.push(check("[LineChart] each data point still renders exactly one value label, positioned at its own point", (lineChartSource.match(/\{item\.value\}/g) ?? []).length === 1 && lineChartSource.includes("y={point.y - 7}")));

  // Bug fix regression: the evidence popover used to be `absolute`-positioned inside
  // its trigger, so it got clipped by ancestor `overflow-hidden`/`overflow-auto`
  // panes near the Artifact pane edges. It must now escape those ancestors via a
  // portal and clamp itself inside the viewport on every side.
  const popoverSource = readFileSync("components/research/ArtifactEvidencePopover.tsx", "utf8");
  results.push(check("[Popover] renders through a portal so ancestor overflow-hidden panes cannot clip it", popoverSource.includes("createPortal(") && popoverSource.includes("document.body")));
  results.push(check("[Popover] Escape and outside click still close it", popoverSource.includes("event.key === \"Escape\"") && popoverSource.includes("handlePointerDown")));

  const insideViewport = computePopoverPosition(
    { top: 300, left: 300, right: 400, bottom: 320 },
    { width: 288, height: 160 },
    { width: 1200, height: 800 },
  );
  results.push(check("[Popover] with room on every side, opens above and left-aligned with the trigger", insideViewport.placement === "top" && insideViewport.left === 300 && insideViewport.top === 300 - 8 - 160));

  const nearRightEdge = computePopoverPosition(
    { top: 300, left: 1150, right: 1180, bottom: 320 },
    { width: 288, height: 160 },
    { width: 1200, height: 800 },
  );
  results.push(check("[Popover] near the right edge, flips so the panel's right edge stays inside the viewport", nearRightEdge.left + 288 <= 1200 - 8 && nearRightEdge.left >= 8));

  const nearTopEdge = computePopoverPosition(
    { top: 20, left: 300, right: 400, bottom: 40 },
    { width: 288, height: 160 },
    { width: 1200, height: 800 },
  );
  results.push(check("[Popover] near the top edge with no room above, flips to open below the trigger", nearTopEdge.placement === "bottom" && nearTopEdge.top === 40 + 8));

  const tallPanelNearBottom = computePopoverPosition(
    { top: 780, left: 300, right: 400, bottom: 795 },
    { width: 288, height: 700 },
    { width: 1200, height: 800 },
  );
  results.push(check("[Popover] a panel taller than the viewport still stays clamped fully on-screen (top and bottom bounds respected)", tallPanelNearBottom.top >= 8 && tallPanelNearBottom.top + 700 <= 800 - 8 + 1));

  return summarize("TACT Research mock Artifact preview", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
