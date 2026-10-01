// =========================
// Root Yolna — Forbidden Standalone-Runs Import Check (SOR-135 Phase 4A)
// =========================
//
// section14指示: "Yolna側からStandalone Runs DBへ直接接続するコードを
// 禁止する方針を作ってください...将来CIへ組み込めるstatic verification"。
//
// This is the REVERSE direction of scripts/verify/standaloneForbiddenImports.ts
// (which checks products/yolna-runs never imports root Yolna code). Together
// the two form a complete bidirectional isolation guarantee around the
// standalone deployment's own private source tree
// (products/yolna-runs/lib/**, products/yolna-runs/app/api/tact/runs/
// ingest/**, etc.) — the only place Yolna -> Runs data flow is permitted
// to physically occur in code is through the explicit, authenticated HTTP
// ingestion endpoints (products/yolna-runs/app/api/tact/runs/ingest/**),
// never by Yolna importing the standalone app's own modules and calling
// its service-role-backed projection writers in-process.
//
// Shared code (@tact/execution-contract, @tact/runs-core — both already
// legitimately consumed by the root Yolna app today, e.g.
// core/tact-execution-yolna-adapter and the embedded Runs UI/API under
// app/api/tact/runs/**) is explicitly NOT forbidden here; only
// products/yolna-runs/** itself is.

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_ROOT = path.join(REPO_ROOT, "products/yolna-runs");

// Scanned directories: root Yolna's own application source. Deliberately
// excludes products/yolna-runs itself (scanned by the Phase 2 check, in
// the other direction) and packages/* (shared code, legitimately imported
// by both products).
const SCAN_ROOTS = ["app", "core", "components", "tests", "experiments", "scripts"].map((d) =>
  path.join(REPO_ROOT, d)
);

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
}

function main(): void {

  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(root));

  if (files.length === 0) {
    console.error("[rootForbiddenStandaloneImport] NOT FOUND: no source files under the configured scan roots");
    process.exit(1);
  }

  const violations: Violation[] = [];

  for (const absFile of files) {

    const content = fs.readFileSync(absFile, "utf-8");
    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");

    for (const imp of extractImports(content)) {

      if (imp.isTypeOnly) {
        continue;
      }

      if (!imp.specifier.startsWith(".") && !imp.specifier.includes("products/yolna-runs")) {
        continue;
      }

      const resolvedAbs = imp.specifier.startsWith(".")
        ? path.resolve(path.dirname(absFile), imp.specifier)
        : null;

      const touchesStandalone =
        (resolvedAbs && resolvedAbs.startsWith(STANDALONE_ROOT)) ||
        imp.specifier.includes("products/yolna-runs");

      if (touchesStandalone) {
        violations.push({ file: relFile, specifier: imp.specifier });
      }

    }

  }

  if (violations.length > 0) {
    console.error(
      `[rootForbiddenStandaloneImport] FAIL: ${violations.length} root Yolna import(s) reach into products/yolna-runs:\n` +
      violations.map((v) => `  ${v.file} -> ${v.specifier}`).join("\n")
    );
    process.exit(1);
  }

  console.log(
    `[rootForbiddenStandaloneImport] PASS: scanned ${files.length} files under ${SCAN_ROOTS.length} root Yolna ` +
    "directories, 0 imports reach into products/yolna-runs (Yolna -> Runs data flow is only possible through " +
    "the authenticated HTTP ingestion endpoints, never an in-process service-role call)"
  );

}

main();
