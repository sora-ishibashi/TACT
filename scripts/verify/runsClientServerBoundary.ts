// =========================
// Standalone Runs — Client/Server Secret Boundary Check (SOR-135 Phase 4A)
// =========================
//
// section11指示: "anon key -> browser利用可、service-role -> server only
// が保証されているか確認" + "Next.jsのclient componentからservice-role
// moduleへimport pathが存在しないことを静的に確認するtest"。
//
// Walks the real static import graph (relative imports + the @tact/*,
// @/* alias prefixes products/yolna-runs actually uses) starting from
// every file under products/yolna-runs/** and packages/runs-core/
// tact-runs-view/** that carries a "use client" directive, and fails if
// that graph can reach packages/runs-core/database/supabaseServiceRole.ts
// — the one module that reads SUPABASE_SERVICE_ROLE_KEY. Reachability is
// transitive: a client component importing a server-only store module
// that itself imports supabaseServiceRole.ts is still a violation, not
// just a direct import of supabaseServiceRole.ts itself.
//
// This is a source-level guarantee (Next.js's own "use client"/bundler
// boundary is the runtime enforcement; this script is the static,
// CI-able check that nothing in this codebase has set up an import path
// that boundary would even need to catch).

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_ROOT = path.join(REPO_ROOT, "products/yolna-runs");
const RUNS_CORE_ROOT = path.join(REPO_ROOT, "packages/runs-core");
const EXECUTION_CONTRACT_ROOT = path.join(REPO_ROOT, "packages/execution-contract");

const SERVICE_ROLE_MODULE = path.join(RUNS_CORE_ROOT, "database/supabaseServiceRole.ts");

const SCAN_ROOTS = [STANDALONE_ROOT, RUNS_CORE_ROOT, EXECUTION_CONTRACT_ROOT];

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

function isUseClientFile(content: string): boolean {

  // "use client" must be the first statement in the file (Next.js's own
  // rule) — check only the first few non-empty, non-comment lines rather
  // than scanning the whole file, so a file that merely mentions the
  // string later doesn't false-positive.
  const lines = content.split("\n").slice(0, 5);

  return lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === '"use client";' || trimmed === "'use client';" || trimmed === '"use client"' || trimmed === "'use client'";
  });

}

const EXTENSION_CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSpecifier(specifier: string, fromFile: string): string | null {

  let baseAbs: string | null = null;

  if (specifier.startsWith(".")) {
    baseAbs = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier === "@tact/execution-contract" || specifier.startsWith("@tact/execution-contract/")) {
    baseAbs = path.join(EXECUTION_CONTRACT_ROOT, specifier.replace("@tact/execution-contract", ""));
  } else if (specifier === "@tact/runs-core" || specifier.startsWith("@tact/runs-core/")) {
    baseAbs = path.join(RUNS_CORE_ROOT, specifier.replace("@tact/runs-core", ""));
  } else if (specifier.startsWith("@/")) {
    baseAbs = path.join(STANDALONE_ROOT, specifier.slice(2));
  } else {
    // A bare npm package (react, next, @supabase/supabase-js, ...) — not
    // part of this repo's own source graph, stop walking here.
    return null;
  }

  for (const candidate of EXTENSION_CANDIDATES) {
    const attempt = baseAbs + candidate;
    if (fs.existsSync(attempt) && fs.statSync(attempt).isFile()) {
      return attempt;
    }
  }

  return null;

}

function findPathToServiceRole(startFile: string, fileCache: Map<string, string>): string[] | null {

  const visited = new Set<string>();
  const queue: Array<{ file: string; path: string[] }> = [{ file: startFile, path: [startFile] }];

  while (queue.length > 0) {

    const { file, path: trail } = queue.shift()!;

    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    if (path.resolve(file) === path.resolve(SERVICE_ROLE_MODULE)) {
      return trail;
    }

    const content = fileCache.get(file) ?? fs.readFileSync(file, "utf-8");
    fileCache.set(file, content);

    for (const imp of extractImports(content)) {

      if (imp.isTypeOnly) {
        continue;
      }

      const resolved = resolveSpecifier(imp.specifier, file);

      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, path: [...trail, resolved] });
      }

    }

  }

  return null;

}

function main(): void {

  if (!fs.existsSync(SERVICE_ROLE_MODULE)) {
    console.error(`[runsClientServerBoundary] NOT FOUND: expected service-role module at ${SERVICE_ROLE_MODULE}`);
    process.exit(1);
  }

  const allFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(root));
  const fileCache = new Map<string, string>();

  const clientFiles = allFiles.filter((file) => {
    const content = fileCache.get(file) ?? fs.readFileSync(file, "utf-8");
    fileCache.set(file, content);
    return isUseClientFile(content);
  });

  if (clientFiles.length === 0) {
    console.error("[runsClientServerBoundary] NOT FOUND: no \"use client\" files found to check — scan roots may be wrong");
    process.exit(1);
  }

  const violations: Array<{ file: string; chain: string[] }> = [];

  for (const clientFile of clientFiles) {

    const chain = findPathToServiceRole(clientFile, fileCache);

    if (chain) {
      violations.push({
        file: path.relative(REPO_ROOT, clientFile).split(path.sep).join("/"),
        chain: chain.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/")),
      });
    }

  }

  // Also report the full set of server-side modules that DO reach the
  // service-role client, for the "service-role使用module一覧" report item
  // — these are expected (server-only code), not failures.
  const serviceRoleUsers = allFiles.filter((file) => {
    if (clientFiles.includes(file)) {
      return false;
    }
    const chain = findPathToServiceRole(file, fileCache);
    return Boolean(chain) && path.resolve(file) !== path.resolve(SERVICE_ROLE_MODULE);
  }).map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"));

  if (violations.length > 0) {
    console.error(
      `[runsClientServerBoundary] FAIL: ${violations.length} "use client" file(s) can reach the service-role module:\n` +
      violations.map((v) => `  ${v.file}\n    via: ${v.chain.join(" -> ")}`).join("\n")
    );
    process.exit(1);
  }

  console.log(
    `[runsClientServerBoundary] PASS: ${clientFiles.length} "use client" file(s) checked, 0 can reach ` +
    `packages/runs-core/database/supabaseServiceRole.ts`
  );
  console.log(
    `[runsClientServerBoundary] service-role-reachable server modules (${serviceRoleUsers.length}):\n` +
    serviceRoleUsers.map((f) => `  ${f}`).join("\n")
  );

}

main();
