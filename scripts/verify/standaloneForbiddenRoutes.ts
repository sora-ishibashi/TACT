// =========================
// Standalone Runs — Forbidden Route Check (SOR-135 Phase 2)
// =========================
//
// CI building block 3/5 (section14指示). products/yolna-runs/app/**
// のNext.js route treeを列挙し、許可されたRunsページ/APIだけが存在する
// ことを確認する(section8指示「Standalone Runsのroute manifestを検査し、
// Yolna routeが0であることを確認」)。
//
// 許可route(page.tsx/route.tsを持つディレクトリのみを数える、
// layout.tsx/globals.css等は対象外):
//   /                                                  (page)
//   /login                                             (page)
//   /api/tact/runs/activity                            (route)
//   /api/tact/runs/attention                           (route)
//   /api/tact/runs/attention/[attentionId]              (route)
//   /api/tact/runs/execution/[executionId]               (route)
//   /api/tact/runs/execution/[executionId]/correlation  (route)
//   /api/tact/runs/execution/[executionId]/reclassify   (route)
//   /api/tact/runs/unassigned                           (route)
//   /api/tact/runs/work                                 (route)
//   /api/tact/runs/work/[workId]                        (route)
//   /api/tact/runs/ingest/work                          (route, SOR-135 Phase 4A)
//   /api/tact/runs/ingest/conversation-link              (route, SOR-135 Phase 4A)
//   /api/tact/runs/ingest/connections                    (route, SOR-212)
//   /api/tact/runs/coverage                              (route, SOR-136)
//   /api/tact/runs/permission-management                 (route, SOR-187)
//   /api/tact/runs/agent-management                       (route, SOR-186)
//   /api/tact/runs/governance/preflight                  (route, SOR-138 Slice 3A-1)
//   /api/tact/runs/governance/complete                   (route, SOR-138 Slice 3A-1)
//
// 禁止route prefix(section8指示、明示的に列挙): chat, research,
// orchestrate, code, runtime, bot, artifacts, attachments, connections,
// legacy agent routes, 任意の /api/tact/<yolna-only> route。

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(REPO_ROOT, "products/yolna-runs/app");

const ALLOWED_ROUTES = new Set([
  "/",
  "/login",
  "/api/tact/runs/activity",
  "/api/tact/runs/attention",
  "/api/tact/runs/attention/[attentionId]",
  "/api/tact/runs/execution/[executionId]",
  "/api/tact/runs/execution/[executionId]/correlation",
  "/api/tact/runs/execution/[executionId]/reclassify",
  "/api/tact/runs/unassigned",
  "/api/tact/runs/work",
  "/api/tact/runs/work/[workId]",
  "/api/tact/runs/ingest/work",
  "/api/tact/runs/ingest/conversation-link",
  "/api/tact/runs/ingest/execution",
  "/api/tact/runs/ingest/connections",
  "/api/tact/runs/coverage",
  "/api/tact/runs/permission-management",
  "/api/tact/runs/agent-management",
  "/api/tact/runs/governance/preflight",
  "/api/tact/runs/governance/complete",
]);

function findRoutes(dir: string, routePath: string, out: string[]): void {

  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {

    if (entry.isFile() && (entry.name === "page.tsx" || entry.name === "page.ts" || entry.name === "route.ts" || entry.name === "route.tsx")) {
      out.push(routePath === "" ? "/" : routePath);
      continue;
    }

    if (entry.isDirectory()) {
      findRoutes(path.join(dir, entry.name), `${routePath}/${entry.name}`, out);
    }

  }

}

function main(): void {

  if (!fs.existsSync(APP_DIR)) {
    console.error(`[standaloneForbiddenRoutes] NOT FOUND: ${APP_DIR}`);
    process.exit(1);
  }

  const found: string[] = [];
  findRoutes(APP_DIR, "", found);

  const foundSet = new Set(found);

  const unexpected = [...foundSet].filter((route) => !ALLOWED_ROUTES.has(route));
  const missing = [...ALLOWED_ROUTES].filter((route) => !foundSet.has(route));

  if (unexpected.length > 0) {
    console.error(
      `[standaloneForbiddenRoutes] FAIL: unexpected route(s) present in products/yolna-runs/app:\n` +
      unexpected.map((r) => `  ${r}`).join("\n")
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `[standaloneForbiddenRoutes] FAIL: expected route(s) missing from products/yolna-runs/app:\n` +
      missing.map((r) => `  ${r}`).join("\n")
    );
    process.exit(1);
  }

  console.log(`[standaloneForbiddenRoutes] PASS: exactly the ${ALLOWED_ROUTES.size} allowed Runs routes exist, 0 unexpected`);

}

main();
