// =========================
// TACT Runs Core — Forbidden Dependency Test (SOR-135 Phase 1/2)
// =========================
//
// 対象: packages/runs-core/tact-execution/**・
// packages/runs-core/tact-runs-view/**(SOR-10監査がRuns Core =
// observation/governance/audit planeと分類した範囲。SOR-135 Phase 2で
// core/tact-execution・core/tact-runs-viewから物理的に移動した)。
//
// この2ディレクトリ配下の全.tsファイルを静的に走査し、import/export-from
// の宣言だけから(実際にimportを評価せず)、禁止された先へのruntime
// dependencyが存在しないことを機械的に確認する。
//
// 禁止対象(SOR-135 Phase1指示section7):
//   - core/tact-orchestrator, core/llm, core/workflow, core/agents,
//     core/brain, core/optimizer
//   - @composio/core, @anthropic-ai/sdk, openai, @tavily/core
// 加えて(SOR-135 Phase1指示section3、Phase1の主目的そのもの):
//   - core/tact-work, core/tact-bot への runtime import
// 加えて(SOR-135 Phase2指示section5、Standalone Runs packageの
// dependency audit):
//   - @trigger.dev/sdk, pptxgenjs, mammoth, pdf-parse, xlsx, jszip,
//     @slack/web-api, @octokit/rest
//
// `import type ... from "..."` / `export type ... from "..."` は対象外
// (SOR-135指示「type-only dependencyについては…分離して扱って構わない」)。
// 検出されたtype-onlyの該当importはFAILにはせず、別途レポートする
// (将来shared contractへ移すべき候補として)。

import * as fs from "node:fs";
import * as path from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = path.resolve(__dirname, "../../..");

const RUNS_CORE_DIRS = ["packages/runs-core/tact-execution", "packages/runs-core/tact-runs-view"];

const FORBIDDEN_INTERNAL_PREFIXES = [
  "core/tact-orchestrator",
  "core/llm",
  "core/workflow",
  "core/agents",
  "core/brain",
  "core/optimizer",
  // SOR-135 Phase1 section3: Runs Core -> Yolna runtime import自体が
  // Phase1の主目的(OPENAI_API_KEY等のeager importの直接原因)。
  "core/tact-work",
  "core/tact-bot",
  // SOR-135 Phase2: Runs Coreは、Yolna-coupledなCompatibility Adapter
  // (root Yolna applicationのcore/tact-execution-yolna-adapter)を
  // 自分自身からimportしてはならない(importするのは常にcaller側)。
  "core/tact-execution-yolna-adapter",
];

const FORBIDDEN_PACKAGES = [
  "@composio/core",
  "@anthropic-ai/sdk",
  "openai",
  "@tavily/core",
  "@trigger.dev/sdk",
  "pptxgenjs",
  "mammoth",
  "pdf-parse",
  "xlsx",
  "jszip",
  "@slack/web-api",
  "@octokit/rest",
];

interface ImportStatement {
  isTypeOnly: boolean;
  specifier: string;
  raw: string;
}

// `from "specifier";` / `from 'specifier';` を伴う import/export、および
// `import "specifier";` の副作用importの両方を拾う(複数行named import
// でも最後は必ず1つのfrom句で終わるため、非貪欲マッチで1宣言ずつ切り出す)。
const FROM_IMPORT_RE = /\b(import|export)\s+(type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["']\s*;/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+["']([^"']+)["']\s*;/g;

function extractImports(content: string): ImportStatement[] {

  const results: ImportStatement[] = [];

  for (const match of content.matchAll(FROM_IMPORT_RE)) {
    results.push({ isTypeOnly: Boolean(match[2]), specifier: match[3], raw: match[0] });
  }

  for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    results.push({ isTypeOnly: false, specifier: match[1], raw: match[0] });
  }

  return results;

}

function listTsFilesRecursive(absDir: string): string[] {

  const out: string[] = [];

  if (!fs.existsSync(absDir)) {
    return out;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {

    const abs = path.join(absDir, entry.name);

    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(abs));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(abs);
    }

  }

  return out;

}

// 相対importをrepo-root相対のPOSIXパスへ解決する(拡張子なし、
// ディレクトリ境界判定にのみ使う)。Windows/POSIX両対応のため、必ず
// path.resolve/path.relative(OS-native)で解決してから最後にpath.sepを
// "/"へ正規化する。
function resolveRelativeSpecifier(fileAbsPath: string, specifier: string): string {

  const fileDir = path.dirname(fileAbsPath);
  const resolvedAbs = path.resolve(fileDir, specifier);
  const relToRoot = path.relative(REPO_ROOT, resolvedAbs);

  return relToRoot.split(path.sep).join("/");

}

interface Violation {
  file: string;
  specifier: string;
  matchedPrefixOrPackage: string;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const runtimeViolations: Violation[] = [];
  const typeOnlyFindings: Violation[] = [];
  let filesScanned = 0;

  for (const relDir of RUNS_CORE_DIRS) {

    const absDir = path.join(REPO_ROOT, relDir);
    const files = listTsFilesRecursive(absDir);

    for (const absFile of files) {

      filesScanned += 1;

      const content = fs.readFileSync(absFile, "utf-8");
      const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");

      for (const imp of extractImports(content)) {

        const isRelative = imp.specifier.startsWith(".");

        let matched: string | null = null;

        if (isRelative) {

          const resolved = resolveRelativeSpecifier(absFile, imp.specifier);

          for (const prefix of FORBIDDEN_INTERNAL_PREFIXES) {
            if (resolved === prefix || resolved.startsWith(prefix + "/")) {
              matched = prefix;
              break;
            }
          }

        } else {

          for (const pkg of FORBIDDEN_PACKAGES) {
            if (imp.specifier === pkg || imp.specifier.startsWith(pkg + "/")) {
              matched = pkg;
              break;
            }
          }

        }

        if (!matched) {
          continue;
        }

        const violation: Violation = { file: relFile, specifier: imp.specifier, matchedPrefixOrPackage: matched };

        if (imp.isTypeOnly) {
          typeOnlyFindings.push(violation);
        } else {
          runtimeViolations.push(violation);
        }

      }

    }

  }

  results.push(
    check(
      "[Scan] Runs Core(core/tact-execution/**, core/tact-runs-view/**)の.tsファイルを少なくとも1件スキャンした",
      filesScanned > 0,
      `filesScanned=${filesScanned}`
    )
  );

  results.push(
    check(
      "[Forbidden/runtime] Runs CoreからYolna runtime(core/tact-orchestrator, core/llm, core/workflow, core/agents, core/brain, core/optimizer, core/tact-work, core/tact-bot)・@composio/core・@anthropic-ai/sdk・openai・@tavily/coreへのruntime importが0件",
      runtimeViolations.length === 0,
      runtimeViolations.length > 0
        ? runtimeViolations.map((v) => `${v.file} -> ${v.specifier} (${v.matchedPrefixOrPackage})`).join("; ")
        : undefined
    )
  );

  // type-only findingsはFAILにしない(SOR-135指示どおり分離して扱う)——
  // ただし存在する場合はsummaryへ必ず出す(将来shared contractへ移すべき
  // 候補の棚卸しとして)。
  results.push(
    check(
      "[Report/type-only] type-onlyのYolna依存(blocker扱いしない、将来shared contract化の候補として報告)",
      true,
      typeOnlyFindings.length > 0
        ? `${typeOnlyFindings.length}件: ${typeOnlyFindings.map((v) => `${v.file} -> ${v.specifier}`).join("; ")}`
        : "0件"
    )
  );

  return summarize("TACT Runs Core — Forbidden Dependency (SOR-135 Phase 1)", results);

}
