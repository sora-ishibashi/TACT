// =========================
// Standalone Runs — Forbidden Source Import Check (SOR-135 Phase 2)
// =========================
//
// CI building block 2/5 (section14指示). products/yolna-runs/** の全
// .ts/.tsx を静的に走査し、import/export-from宣言だけから、Yolna
// application code・禁止packageへのruntime importが存在しないことを
// 機械的に確認する(tests/tact/execution/runsCoreForbiddenDependency.test.ts
// と同じ静的scan方式、対象ディレクトリだけが異なる)。
//
// 禁止対象:
//   - 絶対パス/相対パスで products/yolna-runs の外(特にroot Yolna
//     applicationの app/・components/{tact以外含む研究・Core・Code}・
//     core/tact-work・core/tact-bot・core/tact-orchestrator・core/llm・
//     core/tact-execution-yolna-adapter等)を直接参照するimport
//   - @composio/core, @anthropic-ai/sdk, openai, @tavily/core,
//     @trigger.dev/sdk, @slack/web-api, @octokit/rest
//
// `import type ...` / `export type ...` はtype-only(常にeraseされる)
// ため対象外。

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_ROOT = path.join(REPO_ROOT, "products/yolna-runs");

const FORBIDDEN_PACKAGES = [
  "@composio/core",
  "@anthropic-ai/sdk",
  "openai",
  "@tavily/core",
  "@trigger.dev/sdk",
  "@slack/web-api",
  "@octokit/rest",
];

// Yolna-coupledと確認済みの具体的なmodule名(core/tact-execution-yolna-adapter
// はRuns Core自身からも、standalone Runs applicationからも、importされて
// はならない——唯一のimport元はroot Yolna applicationのapp/api/tact/runs/**)。
const FORBIDDEN_SPECIFIC_MODULES = [
  "core/tact-execution-yolna-adapter",
  "core/tact-work",
  "core/tact-bot",
  "core/tact-orchestrator",
  "core/llm",
  "core/workflow",
  "core/agents",
  "core/brain",
  "core/optimizer",
];

interface ImportStatement {
  isTypeOnly: boolean;
  specifier: string;
}

const FROM_IMPORT_RE = /\b(import|export)\s+(type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["']\s*;/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+["']([^"']+)["']\s*;/g;

function extractImports(content: string): ImportStatement[] {

  const results: ImportStatement[] = [];

  for (const match of content.matchAll(FROM_IMPORT_RE)) {
    results.push({ isTypeOnly: Boolean(match[2]), specifier: match[3] });
  }

  for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    results.push({ isTypeOnly: false, specifier: match[1] });
  }

  return results;

}

function listSourceFiles(absDir: string): string[] {

  const out: string[] = [];

  if (!fs.existsSync(absDir)) {
    return out;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {

    const abs = path.join(absDir, entry.name);

    if (entry.isDirectory()) {

      if (entry.name === "node_modules" || entry.name === ".next") {
        continue;
      }

      out.push(...listSourceFiles(abs));
      continue;

    }

    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(abs);
    }

  }

  return out;

}

interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

function main(): void {

  const files = listSourceFiles(STANDALONE_ROOT);

  if (files.length === 0) {
    console.error(`[standaloneForbiddenImports] NOT FOUND: no source files under ${STANDALONE_ROOT}`);
    process.exit(1);
  }

  const runtimeViolations: Violation[] = [];

  for (const absFile of files) {

    const content = fs.readFileSync(absFile, "utf-8");
    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");

    for (const imp of extractImports(content)) {

      if (imp.isTypeOnly) {
        continue;
      }

      // 絶対/相対いずれでも、products/yolna-runs の外(root Yolna
      // applicationのsource tree)を指す相対importを検出する。
      if (imp.specifier.startsWith(".")) {

        const resolvedAbs = path.resolve(path.dirname(absFile), imp.specifier);

        if (!resolvedAbs.startsWith(STANDALONE_ROOT)) {
          runtimeViolations.push({
            file: relFile,
            specifier: imp.specifier,
            reason: "escapes products/yolna-runs via a relative import",
          });
        }

        continue;

      }

      // "@/core/tact-work" (this app's own "@/*" -> "./*" alias) is just as
      // forbidden as a bare "core/tact-work" specifier would be — check
      // both forms since this app's own files always use the "@/" form.
      const aliasStripped = imp.specifier.startsWith("@/") ? imp.specifier.slice(2) : imp.specifier;

      for (const forbiddenModule of FORBIDDEN_SPECIFIC_MODULES) {
        if (aliasStripped === forbiddenModule || aliasStripped.startsWith(forbiddenModule + "/")) {
          runtimeViolations.push({ file: relFile, specifier: imp.specifier, reason: "Yolna-coupled module" });
        }
      }

      for (const pkg of FORBIDDEN_PACKAGES) {
        if (imp.specifier === pkg || imp.specifier.startsWith(pkg + "/")) {
          runtimeViolations.push({ file: relFile, specifier: imp.specifier, reason: "forbidden package" });
        }
      }

    }

  }

  if (runtimeViolations.length > 0) {
    console.error(
      `[standaloneForbiddenImports] FAIL: ${runtimeViolations.length} forbidden runtime import(s):\n` +
      runtimeViolations.map((v) => `  ${v.file} -> ${v.specifier} (${v.reason})`).join("\n")
    );
    process.exit(1);
  }

  console.log(`[standaloneForbiddenImports] PASS: scanned ${files.length} files under products/yolna-runs, 0 forbidden runtime imports`);

}

main();
