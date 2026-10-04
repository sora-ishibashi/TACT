// =========================
// Standalone Runs — Deployment Artifact Audit (SOR-135 Phase 4A)
// =========================
//
// section7指示: run a production build and confirm the actual BUILT
// artifact (not just source imports — scripts/verify/standaloneForbidden
// Imports.ts already covers source) contains none of: Yolna UI (Research/
// Core/Code/ProductLauncher/legacy Agents), Orchestrator, OpenAI provider,
// Anthropic provider, Composio, Trigger.dev execution path, Yolna API,
// Yolna DB migrations.
//
// Must run AFTER `npm run build` inside products/yolna-runs (does not
// build anything itself — same precondition as
// scripts/verify/standaloneDependencyAudit.ts).
//
// Why scan built output instead of only source: minification erases most
// identifier names, but literal strings baked into an SDK (its real API
// hostname, its own package name embedded in a User-Agent header, a
// license banner) survive minification and only appear in the bundle if
// that SDK's code was actually included — this catches what source-level
// import scanning could miss (a dynamic require, an accidental transitive
// bundle, a webpack tree-shaking failure), not just what source-level
// scanning already catches.
//
// Yolna DB migrations: not re-checked here by design — they live under
// root supabase/migrations/, structurally outside products/yolna-runs
// entirely (Runs' own migrations are products/yolna-runs/supabase/
// migrations/, verified independent in Phase 3's dbIndependenceCheck.sh)
// and are SQL files, never part of a Next.js build output regardless.

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_DIR = process.env.STANDALONE_DIR
  ? path.resolve(process.env.STANDALONE_DIR)
  : path.join(REPO_ROOT, "products/yolna-runs");
const BUILD_DIR = path.join(STANDALONE_DIR, ".next");

// Literal strings that only appear in the bundle if the named package's
// real code was included — not identifier names (those get mangled).
const FORBIDDEN_ARTIFACT_SIGNATURES: Array<{ label: string; pattern: string }> = [
  { label: "OpenAI provider", pattern: "api.openai.com" },
  { label: "Anthropic provider", pattern: "api.anthropic.com" },
  { label: "Composio", pattern: "composio.dev" },
  { label: "Composio (API key env name)", pattern: "COMPOSIO_API_KEY" },
  { label: "Trigger.dev execution path", pattern: "trigger.dev" },
  { label: "Trigger.dev execution path", pattern: "@trigger.dev/sdk" },
  { label: "Tavily search", pattern: "api.tavily.com" },
  { label: "Brave search", pattern: "api.search.brave.com" },
  { label: "Slack Web API (bot token path)", pattern: "SLACK_BOT_TOKEN" },
  { label: "GitHub write access (Octokit)", pattern: "@octokit/rest" },
  { label: "legacy Yolna workflow engine", pattern: "core/workflow" },
  { label: "legacy Yolna agents", pattern: "core/agents" },
  { label: "Yolna Orchestrator", pattern: "tact-orchestrator" },
  { label: "Yolna Brain/Optimizer evaluation layer", pattern: "core/brain" },
];

function listFiles(absDir: string): string[] {

  const out: string[] = [];

  if (!fs.existsSync(absDir)) {
    return out;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {

    const abs = path.join(absDir, entry.name);

    if (entry.isDirectory()) {
      out.push(...listFiles(abs));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".json") || entry.name.endsWith(".html"))) {
      out.push(abs);
    }

  }

  return out;

}

interface Finding {
  label: string;
  pattern: string;
  file: string;
}

function main(): void {

  if (!fs.existsSync(BUILD_DIR)) {
    console.error(
      `[standaloneDeploymentArtifactAudit] NOT FOUND: ${BUILD_DIR} — run \`npm run build\` inside ` +
      "products/yolna-runs (or set STANDALONE_DIR) before this check."
    );
    process.exit(1);
  }

  const files = listFiles(BUILD_DIR);

  if (files.length === 0) {
    console.error(`[standaloneDeploymentArtifactAudit] NOT FOUND: no build output files under ${BUILD_DIR}`);
    process.exit(1);
  }

  const findings: Finding[] = [];

  for (const absFile of files) {

    const content = fs.readFileSync(absFile, "utf-8");
    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");

    for (const { label, pattern } of FORBIDDEN_ARTIFACT_SIGNATURES) {
      if (content.includes(pattern)) {
        findings.push({ label, pattern, file: relFile });
      }
    }

  }

  if (findings.length > 0) {
    console.error(
      `[standaloneDeploymentArtifactAudit] FAIL: ${findings.length} forbidden signature(s) present in the built artifact:\n` +
      findings.map((f) => `  ${f.file}: "${f.pattern}" (${f.label})`).join("\n")
    );
    process.exit(1);
  }

  console.log(
    `[standaloneDeploymentArtifactAudit] PASS: scanned ${files.length} built file(s) under ${BUILD_DIR}, ` +
    `0/${FORBIDDEN_ARTIFACT_SIGNATURES.length} forbidden signatures present`
  );

}

main();
