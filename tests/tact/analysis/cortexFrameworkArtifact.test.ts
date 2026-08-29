import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildResearchFrameworkArtifacts, frameworkResultToTableBlock, mergeResearchFrameworkBlocks } from "../../../core/tact-analysis/framework/artifactIntegration";
import type { FrameworkResult } from "../../../core/tact-analysis/framework/types";
import { check, summarize, type CheckResult } from "../lib/check";

function result(frameworkId: FrameworkResult["frameworkId"]): FrameworkResult {
  const section = frameworkId === "framework.swot" ? "strength" : frameworkId === "framework.3c" ? "customer" : "political";
  return { frameworkId, frameworkVersion: "1", sourceEvidenceIds: ["ev1", "ev2"], warnings: [], sections: [{ id: section, label: section, sourceEvidenceIds: ["ev1", "ev2"], items: [{ id: "fact", sectionId: section, kind: "fact", text: "Evidence-backed fact", sourceEvidenceIds: ["ev1"] }, { id: "inference", sectionId: section, kind: "inference", text: "Cautious inference", sourceEvidenceIds: ["ev2"], confidence: "medium" }] }] };
}

export async function run() {
  const checks: CheckResult[] = [];
  const swot = frameworkResultToTableBlock(result("framework.swot"));
  checks.push(check("[Table] Fact and Inference remain visibly distinct", swot.type === "table" && swot.columns.join(",") === "Section,Kind,Content,Evidence" && swot.rows.map((row) => row[1]).join(",") === "Fact,Inference"));
  checks.push(check("[Provenance] Table keeps block, row, and content-cell evidence", swot.sourceEvidenceIds?.join(",") === "ev1,ev2" && swot.rowSourceEvidenceIds?.[1]?.[0] === "ev2" && swot.cellSourceEvidenceIds?.[1]?.[2]?.[0] === "ev2"));
  const artifacts = buildResearchFrameworkArtifacts([result("framework.swot"), result("framework.3c"), result("framework.pest")]);
  const merged = mergeResearchFrameworkBlocks([], artifacts);
  checks.push(check("[Adapter] SWOT, 3C, and PEST use existing TableBlocks", merged.length === 3 && merged.every((block) => block.type === "table") && new Set(merged.map((block) => block.id)).size === 3));
  const refreshed = mergeResearchFrameworkBlocks(merged, [artifacts[0]]);
  checks.push(check("[Flow] same framework table is updated, not duplicated", refreshed.length === 3));
  return summarize("cortexFrameworkArtifact", checks);
}

const direct = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (direct === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
