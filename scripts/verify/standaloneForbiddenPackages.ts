// =========================
// Standalone Runs — Forbidden Package Check (SOR-135 Phase 2)
// =========================
//
// CI building block 1/5 (section14指示). products/yolna-runs/package.json
// の dependencies/devDependencies を静的に読み、Yolna専用package(LLM
// provider SDK・Composio・Trigger.dev・Office/Document parsing library等)
// が1件も直接依存として宣言されていないことを確認する。
//
// 直接依存の宣言を見るだけで十分: 直接依存に無ければ、
// package-lock.jsonのdependency treeにも(他の直接依存の意図しない
// transitive依存を除き)現れない。transitive dependencyとして偶発的に
// 含まれていないかはscripts/verify/standaloneDependencyAudit.ts
// (`npm ls`ベース、実際にnpm installした後にのみ実行可能)が別途確認する
// ——このfileはpackage.json自体の宣言だけを、npm install無しで即座に
// 確認できる軽量なfirst-passとして位置づける。

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_PACKAGE_JSON = path.join(REPO_ROOT, "products/yolna-runs/package.json");

// SOR-135 Phase2指示section5の明示的な禁止list。
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
  // SOR-10監査で確認済み: Runs自身は使わないYolna専用provider client。
  "@slack/web-api",
  "@octokit/rest",
];

function main(): void {

  if (!fs.existsSync(STANDALONE_PACKAGE_JSON)) {
    console.error(`[standaloneForbiddenPackages] NOT FOUND: ${STANDALONE_PACKAGE_JSON}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(STANDALONE_PACKAGE_JSON, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const violations = FORBIDDEN_PACKAGES.filter((name) => declared.has(name));

  if (violations.length > 0) {
    console.error(
      `[standaloneForbiddenPackages] FAIL: products/yolna-runs/package.json declares forbidden package(s): ${violations.join(", ")}`
    );
    process.exit(1);
  }

  console.log(
    `[standaloneForbiddenPackages] PASS: 0/${FORBIDDEN_PACKAGES.length} forbidden packages declared ` +
    `(declared deps: ${[...declared].sort().join(", ")})`
  );

}

main();
