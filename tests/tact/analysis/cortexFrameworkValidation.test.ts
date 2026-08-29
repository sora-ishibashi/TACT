import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFrameworkCortexRegistry } from "../../../core/tact-analysis/framework/bootstrap";
import type { FrameworkInput, FrameworkResult } from "../../../core/tact-analysis/framework/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run() {
  const checks: CheckResult[] = [];
  const registry = createFrameworkCortexRegistry();
  const duplicate = await registry.execute<FrameworkInput, FrameworkResult>("framework.swot", {
    objective: "SWOT analysis",
    evidence: [
      { id: "ev-a", claim: "", text: "company strength: customer base" },
      { id: "ev-b", claim: "", text: "company strength: customer base" },
    ],
  }, { version: "1" });
  checks.push(check("[Duplicate] exact facts merge provenance", duplicate.output?.sections[0]?.items.length === 1 && duplicate.output.sections[0].sourceEvidenceIds.join(",") === "ev-a,ev-b"));
  const conflict = await registry.execute<FrameworkInput, FrameworkResult>("framework.swot", {
    objective: "SWOT analysis",
    evidence: [
      { id: "growth", claim: "", text: "external opportunity: market growth" },
      { id: "decline", claim: "", text: "external opportunity: market decline" },
    ],
  }, { version: "1" });
  checks.push(check("[Conflict] competing facts remain visible", conflict.output?.sections[2]?.items.length === 2 && conflict.warnings.some((issue) => issue.code === "CONFLICTING_FRAMEWORK_EVIDENCE")));
  const unsupported = await registry.execute<FrameworkInput, FrameworkResult>("framework.swot", {
    objective: "SWOT analysis",
    evidence: [{ id: "", claim: "", text: "company strength: customer base" }],
  }, { version: "1" });
  checks.push(check("[Validation] missing provenance is rejected", unsupported.status === "partial" && unsupported.warnings.some((issue) => issue.code === "UNSUPPORTED_FRAMEWORK_ITEM")));
  return summarize("cortexFrameworkValidation", checks);
}

const direct = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (direct === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
