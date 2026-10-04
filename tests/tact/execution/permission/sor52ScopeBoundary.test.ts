// =========================
// TACT Canonical Execution — SOR-52 Scope Boundary Regression
// =========================
//
// SOR-52指示section2「今回実装しない」/section16「15. SOR-53
// correlation logicを呼ばない」を、実際のfile内容をscanして確認する
// ——手動レビューに頼らない回帰確認(experiments側のscopeBoundary.test.ts
// と同じ方針)。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const PERMISSION_DIR = join(__dirname, "..", "..", "..", "..", "packages", "runs-core", "tact-execution", "permission");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      out.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".ts")) {
      out.push(fullPath);
    }
  }
  return out;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];
  const files = listTsFiles(PERMISSION_DIR).map((path) => ({ path, content: readFileSync(path, "utf8") }));

  results.push(check(
    "sanity: the scan actually found permission/ source files",
    files.length >= 6
  ));

  const referencingCorrelation = files.filter((f) =>
    /tact-execution\/correlation/u.test(f.content) || /from ["']\.\.\/correlation/u.test(f.content)
  );

  results.push(check(
    "[Required test 15] core/tact-execution/permission/ does not import from core/tact-execution/correlation/ (Work correlation, SOR-53)",
    referencingCorrelation.length === 0,
    referencingCorrelation.map((f) => f.path).join(", ")
  ));

  const referencingWorkStore = files.filter((f) => /tact-work\/store/u.test(f.content));

  results.push(check(
    "[Section2] permission/ does not reach into Work candidate search (core/tact-work/store) directly",
    referencingWorkStore.length === 0,
    referencingWorkStore.map((f) => f.path).join(", ")
  ));

  const referencingUiOrNotification = files.filter((f) =>
    /slack.*(webhook|notify)|nodemailer|sendgrid|smtp/iu.test(f.content)
  );

  results.push(check(
    "[Section2] permission/ does not implement UI rendering, push/Slack/email notification, or approval execution",
    referencingUiOrNotification.length === 0,
    referencingUiOrNotification.map((f) => f.path).join(", ")
  ));

  return summarize("TACT Canonical Execution — SOR-52 Scope Boundary", results);

}
