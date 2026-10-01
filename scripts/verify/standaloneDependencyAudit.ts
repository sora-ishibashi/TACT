// =========================
// Standalone Runs — Dependency Artifact Audit (SOR-135 Phase 2 section12)
// =========================
//
// Must run AFTER `npm install`/`npm ci` inside products/yolna-runs (this
// script does not install anything itself — it inspects whatever
// node_modules already resolved there, via `npm ls`, so it also works
// against the isolated tree scripts/verify/standaloneCleanInstall.sh
// produces if pointed at it with STANDALONE_DIR).
//
// For each forbidden package, runs `npm ls <pkg> --all` and asserts npm
// reports it absent from the resolved dependency tree (npm ls exits
// non-zero and prints "(empty)"/"not found" when a package is not in the
// tree — this is the actual installed artifact, not just package.json's
// declared dependencies, so it also catches an accidental transitive
// dependency pulled in by something else).

import { execFileSync } from "node:child_process";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_DIR = process.env.STANDALONE_DIR
  ? path.resolve(process.env.STANDALONE_DIR)
  : path.join(REPO_ROOT, "products/yolna-runs");

const FORBIDDEN_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@composio/core",
  "@trigger.dev/sdk",
  "@tavily/core",
  "pptxgenjs",
  "mammoth",
  "pdf-parse",
  "xlsx",
  "jszip",
  "@slack/web-api",
  "@octokit/rest",
];

const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function isPresentInTree(pkgName: string): boolean {

  try {

    const output = execFileSync(NPM_BIN, ["ls", pkgName, "--all", "--json"], {
      cwd: STANDALONE_DIR,
      encoding: "utf-8",
      // npm ls exits non-zero both for "not found" (what we want) and for
      // unrelated tree problems (peer dep conflicts etc.) — we still need
      // its stdout in either case to tell those apart, so don't let a
      // non-zero exit throw here.
      stdio: ["ignore", "pipe", "pipe"],
      // Windows: npm ships as npm.cmd, which execFileSync cannot spawn
      // directly without going through a shell (EINVAL otherwise). Safe
      // here specifically because every arg is a hardcoded constant from
      // FORBIDDEN_PACKAGES above, never user/CLI input.
      shell: process.platform === "win32",
    });

    const parsed = JSON.parse(output) as { dependencies?: Record<string, unknown> };
    return Boolean(parsed.dependencies && Object.keys(parsed.dependencies).length > 0);

  } catch (error) {

    const execError = error as { stdout?: Buffer | string };

    if (!execError.stdout) {
      // npm itself failed to run (not installed, wrong cwd, etc.) — this is
      // an audit infrastructure failure, not "package absent".
      throw error;
    }

    try {
      const parsed = JSON.parse(execError.stdout.toString()) as { dependencies?: Record<string, unknown> };
      return Boolean(parsed.dependencies && Object.keys(parsed.dependencies).length > 0);
    } catch {
      // npm ls with no matches prints a non-JSON "(empty)" on some
      // versions instead of {} — treat unparsable output as absent.
      return false;
    }

  }

}

function main(): void {

  console.log(`[standaloneDependencyAudit] inspecting resolved dependency tree at: ${STANDALONE_DIR}`);

  const present = FORBIDDEN_PACKAGES.filter((pkg) => isPresentInTree(pkg));

  if (present.length > 0) {
    console.error(
      `[standaloneDependencyAudit] FAIL: forbidden package(s) present in the resolved node_modules tree: ${present.join(", ")}\n` +
      "Run `npm ls <pkg> --all` for each to see what pulled it in (direct dependency vs. accidental transitive)."
    );
    process.exit(1);
  }

  console.log(`[standaloneDependencyAudit] PASS: 0/${FORBIDDEN_PACKAGES.length} forbidden packages present in the resolved dependency tree`);

}

main();
