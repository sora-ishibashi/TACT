// =========================
// TACT Runs Core — Import Isolation Regression (SOR-135 Phase 1)
// =========================
//
// SOR-135指示section4(最重要Regression): core/tact-execution/index.tsを
// OPENAI_API_KEY/ANTHROPIC_API_KEY/COMPOSIO_API_KEY/TAVILY_API_KEYの
// いずれも無い状態でimportしても成功すること。
//
// この4つのsecretのうち1つでも欠けている状態で、core/tact-work/store.ts
// (core/tact-orchestrator経由でcore/llm/providers/openai.ts等、module
// scopeでOPENAI_API_KEY等の存在を検証してthrowするfileへ到達する)を
// 静的importしてしまうと、importするだけでプロセスがクラッシュする
// ——このtest fileが実際に検証するのはまさにその回帰。
//
// このprocess自身(tests/tact/runAll.ts経由)は既にdotenv/configで実際の
// .envを読み込んでおり、他の多くのTestFileが既にcore/llmを読み込み
// 済み(module cacheに載っている)ため、このprocess内でそのままimportを
// 試しても何も検証できない。したがって、毎回"npx tsx"の独立した
// child processでscripts/verify/runsCoreImportProbe.tsを実行し、親
// processのenvから対象のsecretだけを明示的に外したenvを渡す
// (絶対条件: 新しいtest frameworkは導入しない、既存のnpx tsx実行方法を
// そのまま使う)。

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts/verify/runsCoreImportProbe.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

const SECRET_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COMPOSIO_API_KEY", "TAVILY_API_KEY"] as const;

function runProbeWithoutEnvKeys(envKeysToDelete: readonly string[]): { success: boolean; detail: string } {

  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of envKeysToDelete) {
    delete env[key];
  }

  const result = spawnSync(process.execPath, [TSX_CLI, PROBE_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 60000,
  });

  const success = result.status === 0 && !result.error;

  const detail = success
    ? ""
    : `status=${result.status ?? "n/a"} error=${result.error?.message ?? "n/a"} stderr=${(result.stderr ?? "").slice(0, 500)}`;

  return { success, detail };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  for (const key of SECRET_ENV_KEYS) {

    const { success, detail } = runProbeWithoutEnvKeys([key]);

    results.push(
      check(
        `[SOR-135/import-isolation] core/tact-execution + core/tact-runs-view import succeeds without ${key}`,
        success,
        detail || undefined
      )
    );

  }

  {
    const { success, detail } = runProbeWithoutEnvKeys(SECRET_ENV_KEYS);

    results.push(
      check(
        "[SOR-135/import-isolation] core/tact-execution + core/tact-runs-view import succeeds with none of OPENAI_API_KEY/ANTHROPIC_API_KEY/COMPOSIO_API_KEY/TAVILY_API_KEY set",
        success,
        detail || undefined
      )
    );
  }

  return summarize("TACT Runs Core — Import Isolation (SOR-135 Phase 1)", results);

}
