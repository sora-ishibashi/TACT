// =========================
// TACT — SEC-P0 Pre-Live Remediation Regression
// =========================
//
// 対象: TACT Pre-Live Full Repository Audit(docs/architecture/
// pre-live-full-audit.md、commit 28f25b9)で確認されたP0 4件の修正。
//
// このrepositoryのapp/api/**route handlerはDI parameterを持たない
// (deps注入されていない)ため、実HTTP requestを構成してmockingする
// 従来のunit test手法は使えない(mocking libraryは新規追加しない、
// 絶対条件)。そのため、このsuiteは2種類の検証を組み合わせる:
//   1. Pure logicとして切り出せる部分(migration drift比較・
//      CodeTask ownership判定)は、実DB接続なしの通常のunit testで
//      直接検証する。
//   2. Route handler自体の認証必須化・shell:true除去は、
//      source-level(実際のfile内容)を読み、期待するcode patternが
//      実際に存在することを確認する構造的テストとする——「認証
//      helperをimportして呼んでいる」「401を返す分岐がある」
//      「shell:trueが無い」という、mockingでは検証しにくい構造的
//      事実を、実際のsource codeそのものから直接確認する。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOwnedBy,
  selectCodeTasksFromRows,
} from "../../../core/codeAgent/store";
import type { CodeTask } from "../../../core/codeAgent/types";
import {
  computeMigrationDrift,
  extractMigrationVersion,
  getLocalMigrationVersions,
  EXIT_OK,
  EXIT_DRIFT,
  EXIT_CHECK_FAILED,
} from "../../../scripts/checkMigrationDrift";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

function makeCodeTask(overrides: Partial<CodeTask> = {}): CodeTask {
  return {
    id: "task-1",
    userId: "user-1",
    proposalId: "proposal-1",
    status: "ready_for_approval",
    executionPolicy: "human_approval_required",
    repositoryPath: "/repo",
    instruction: "do something",
    targetFiles: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  } as CodeTask;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // P0-1: CodeTask ownership判定(pure logic、実DB接続なし)
  // =========================

  {
    const owner = makeCodeTask({ userId: "user-1" });
    const other = makeCodeTask({ userId: "user-2", id: "task-2" });
    const orphan = makeCodeTask({ userId: undefined, id: "task-3" });

    results.push(
      check(
        "[P0-1] isOwnedBy(): 所有者本人はtrue、authenticated userでも他人のresourceはfalse",
        isOwnedBy(owner, "user-1") === true &&
          isOwnedBy(other, "user-1") === false &&
          isOwnedBy(orphan, "user-1") === false
      )
    );

    results.push(
      check(
        "[P0-1] isOwnedBy(): userId省略(内部専用呼び出し)時は絞り込まない(既存の非owner-scoped呼び出しとの後方互換)",
        isOwnedBy(owner, undefined) === true && isOwnedBy(other, undefined) === true
      )
    );
  }

  // 既存のselectCodeTasksFromRows()自体(recordKind除外ロジック)が
  // 今回の変更で壊れていないことも合わせて確認する(回帰確認)。
  {
    const rows = [
      { content: makeCodeTask({ id: "a" }) },
      { content: { recordKind: "development_task" } },
      { content: makeCodeTask({ id: "b" }) },
    ];

    const selected = selectCodeTasksFromRows(rows, 10);

    results.push(
      check(
        "[P0-1] selectCodeTasksFromRows(): 既存のrecordKind除外ロジックは今回の変更後も維持されている",
        selected.length === 2 && selected.every((t) => t.id === "a" || t.id === "b")
      )
    );
  }

  // =========================
  // P0-1: route levelのauth必須化(source-level構造確認)
  // =========================

  {
    const codeTasksRoutes = [
      "app/api/tact/code-tasks/route.ts",
      "app/api/tact/code-tasks/run/route.ts",
      "app/api/tact/code-tasks/approve/route.ts",
      "app/api/tact/code-tasks/execute/route.ts",
      "app/api/tact/code-tasks/commit/route.ts",
      "app/api/tact/code-tasks/push/route.ts",
      "app/api/tact/code-tasks/pull-request/route.ts",
    ];

    const missingAuth = codeTasksRoutes.filter((path) => {
      const source = readRepoFile(path);
      return (
        !source.includes("getCurrentUserContext") ||
        !source.includes("authentication required") ||
        !source.includes("401")
      );
    });

    results.push(
      check(
        "[P0-1] app/api/tact/code-tasks/**の全POST/GET routeがgetCurrentUserContext()を呼び、未認証時に401を返す分岐を持つ",
        missingAuth.length === 0,
        missingAuth.length > 0 ? `missing auth in: ${missingAuth.join(", ")}` : undefined
      )
    );
  }

  // owner-scopeがgetCodeTask呼び出しへ実際に伝播しているか
  // (userIdを渡さずgetCodeTask(id)だけを呼ぶ既存の書き方が残って
  // いないか)を、各routeのsource内で確認する。
  {
    const ownerScopedRoutes = [
      "app/api/tact/code-tasks/approve/route.ts",
      "app/api/tact/code-tasks/execute/route.ts",
      "app/api/tact/code-tasks/commit/route.ts",
      "app/api/tact/code-tasks/push/route.ts",
      "app/api/tact/code-tasks/pull-request/route.ts",
    ];

    const notOwnerScoped = ownerScopedRoutes.filter((path) => {
      const source = readRepoFile(path);
      return !/getCodeTask\(\s*id\s*,\s*userId\s*\)/.test(source);
    });

    results.push(
      check(
        "[P0-1] approve/execute/commit/push/pull-requestの全routeがgetCodeTask(id, userId)でowner-scopedに取得している(認証済みでも他人のCodeTaskへ到達できない)",
        notOwnerScoped.length === 0,
        notOwnerScoped.length > 0 ? `not owner-scoped: ${notOwnerScoped.join(", ")}` : undefined
      )
    );
  }

  // =========================
  // P0-1: gh CLI shell:true除去(command injection対策)
  // =========================

  {
    const gitProviderSource = readRepoFile("core/codeAgent/gitProvider.ts");

    // "gh"を呼ぶexecFileブロックだけを対象にする(git本体のexecFileは
    // 元々shell:trueを使っておらず対象外、既存挙動を変えない)。
    const ghExecFileBlocks =
      gitProviderSource.match(/execFile\(\s*"gh",[\s\S]{0,400}?\)\s*;?/g) ?? [];

    const stillUsesShellTrue = ghExecFileBlocks.some((block) => /shell\s*:\s*true/.test(block));

    results.push(
      check(
        "[P0-1] gh CLI呼び出し(gh auth status / gh pr create)のいずれもshell:trueを使っていない(command injection対策)",
        ghExecFileBlocks.length >= 2 && !stillUsesShellTrue,
        `found ${ghExecFileBlocks.length} gh execFile block(s)`
      )
    );

    results.push(
      check(
        "[P0-1] gh pr createの引数(--title/--body等)は配列要素のまま渡され、shell文字列へ連結されていない(malicious title/bodyがshell実行にならない構造的証拠)",
        /\[\s*"pr",\s*"create",[\s\S]*?"--title",\s*params\.title,[\s\S]*?"--body",\s*params\.body,[\s\S]*?\]/.test(
          gitProviderSource
        )
      )
    );
  }

  // =========================
  // P0-2: Legacy route(/api/tact, /api/tact/stream)のauth必須化
  // =========================

  {
    const legacyRoutes = ["app/api/tact/route.ts", "app/api/tact/stream/route.ts"];

    const missingAuth = legacyRoutes.filter((path) => {
      const source = readRepoFile(path);
      return (
        !source.includes("getCurrentUserContext") ||
        !source.includes("authentication required") ||
        !source.includes("401")
      );
    });

    results.push(
      check(
        "[P0-2] app/api/tact/route.ts・app/api/tact/stream/route.tsの両方がgetCurrentUserContext()を呼び、未認証時に401を返す(Legacy workflow engineへ認証前に到達しない)",
        missingAuth.length === 0,
        missingAuth.length > 0 ? `missing auth in: ${missingAuth.join(", ")}` : undefined
      )
    );

    // 認証チェックがrunWorkflow()呼び出しよりも前に書かれていることを
    // 確認する(認証失敗時にLLM/DB呼び出しへ一切到達しないことの
    // source-level証拠)。
    const orderingOk = legacyRoutes.every((path) => {
      const source = readRepoFile(path);
      const authIndex = source.indexOf("getCurrentUserContext");
      const workflowIndex = source.indexOf("runWorkflow(");
      return authIndex !== -1 && workflowIndex !== -1 && authIndex < workflowIndex;
    });

    results.push(
      check(
        "[P0-2] 認証チェックはrunWorkflow()呼び出しより前に書かれている(認証失敗時、LLM実行に到達しない)",
        orderingOk
      )
    );
  }

  // =========================
  // P0-3: Legacy Stage-0 tables — using(true) policy除去
  // =========================

  {
    const migrationPath =
      "supabase/migrations/20260913000000_restrict_legacy_stage0_tables_to_service_role.sql";
    const migrationSource = readRepoFile(migrationPath);

    const expectedDroppedPolicies = [
      "conversations_select_anon_stage0",
      "conversations_insert_anon_stage0",
      "conversations_update_anon_stage0",
      "conversations_delete_anon_stage0",
      "conversation_messages_select_anon_stage0",
      "conversation_messages_insert_anon_stage0",
      "conversation_messages_update_anon_stage0",
      "conversation_messages_delete_anon_stage0",
      "conversation_workflow_runs_select_anon_stage0",
      "conversation_workflow_runs_insert_anon_stage0",
      "conversation_workflow_runs_update_anon_stage0",
      "conversation_workflow_runs_delete_anon_stage0",
      "tact_execution_history_select_anon_stage0",
      "tact_execution_history_insert_anon_stage0",
      "tact_memory_select_anon_stage0",
      "tact_memory_insert_anon_stage0",
      "tact_memory_update_anon_stage0",
      "tact_memory_delete_agent_handoff_anon_stage0",
      "tact_core_knowledge_select_anon_stage0",
      "tact_core_knowledge_insert_anon_stage0",
      "tact_core_knowledge_update_anon_stage0",
      "tact_core_memories_select_anon_stage0",
      "tact_core_memories_insert_anon_stage0",
      "tact_core_memories_update_anon_stage0",
      "tact_core_examples_select_anon_stage0",
      "tact_core_examples_insert_anon_stage0",
    ];

    const notDropped = expectedDroppedPolicies.filter(
      (policyName) => !migrationSource.includes(`drop policy if exists "${policyName}"`)
    );

    results.push(
      check(
        `[P0-3] migration ${migrationPath}が対象8テーブルの全26個のanon_stage0 policyをdropしている`,
        notDropped.length === 0,
        notDropped.length > 0 ? `not dropped: ${notDropped.join(", ")}` : undefined
      )
    );

    const introducesNewPermissivePolicy = /create\s+policy/i.test(migrationSource);

    results.push(
      check(
        "[P0-3] このmigrationは新しいpolicyを1件も作成していない(drop only、using(true)の再導入が無い)",
        !introducesNewPermissivePolicy
      )
    );

    // コメント行(このmigration自身が「何をdropするか」を説明する中で
    // "using(true)"という語彙に言及している)を除外し、実際のSQL文
    // だけを対象にする——コメント中の言及まで検出すると誤検知になる。
    const migrationSqlOnly = migrationSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    results.push(
      check(
        "[P0-3] using(true) count after fix = 0(このmigrationが実際に定義するSQL文の中にusing(true)相当の許可文言が存在しない、コメント中の言及は除く)",
        !/using\s*\(\s*true\s*\)/i.test(migrationSqlOnly) &&
          !/with check\s*\(\s*true\s*\)/i.test(migrationSqlOnly)
      )
    );
  }

  // 対象7ファイルが、共有anon client(core/database/supabase.ts)を
  // もはや直接importしていないことを確認する(service role clientへの
  // 差し替えが実際に行われている構造的証拠)。
  {
    const convertedFiles = [
      "core/brain/memory.ts",
      "core/brain/history.ts",
      "core/conversation/store.ts",
      "core/codeAgent/store.ts",
      "core/tact-agent/supabaseStore.ts",
      "core/tact-core/supabaseCoreCapability.ts",
      "betaUsageReport.ts",
    ];

    const stillUsesAnonClient = convertedFiles.filter((path) => {
      const source = readRepoFile(path);
      return /from ["'].*\/database\/supabase["']/.test(source) &&
        !/from ["'].*\/database\/supabase["'];?\s*\n.*ServiceRole/.test(source);
    });

    // より単純かつ確実な判定: getServiceRoleClientをimportしており、
    // かつ plain な `{ supabase }` importが残っていないこと。
    const notConverted = convertedFiles.filter((path) => {
      const source = readRepoFile(path);
      const usesServiceRole = source.includes("getServiceRoleClient");
      const stillImportsPlainSupabase = /import\s*\{\s*supabase\s*\}\s*from/.test(source);
      return !usesServiceRole || stillImportsPlainSupabase;
    });

    results.push(
      check(
        "[P0-3] tact_memory/tact_execution_history/conversations系を触る対象7ファイルが、共有anon client({supabase})ではなくgetServiceRoleClient()を使うよう更新されている",
        notConverted.length === 0,
        notConverted.length > 0 ? `not converted: ${notConverted.join(", ")}` : undefined
      )
    );

    void stillUsesAnonClient;
  }

  // =========================
  // P0-4: Migration drift detection(pure logic、実DB接続なし)
  // =========================

  {
    const drift = computeMigrationDrift(
      ["20260910000000", "20260911000000", "20260912000000"],
      ["20260910000000", "20260911000000", "20260912000000"]
    );

    results.push(
      check(
        "[P0-4] 全migrationが適用済みの場合、missing=[](exit 0相当)",
        drift.missing.length === 0
      )
    );
  }

  {
    const drift = computeMigrationDrift(
      ["20260910000000", "20260911000000", "20260912000000"],
      ["20260910000000"]
    );

    results.push(
      check(
        "[P0-4] 未適用migrationをsimulateした場合、missingへ正確にその2件が列挙される(exit 1相当)",
        drift.missing.length === 2 &&
          drift.missing.includes("20260911000000") &&
          drift.missing.includes("20260912000000")
      )
    );
  }

  results.push(
    check(
      "[P0-4] extractMigrationVersion(): 既存migrationファイル名の命名規則(YYYYMMDDHHMMSS_description.sql)からversionを正しく抽出する",
      extractMigrationVersion("20260912000000_create_tact_audit_events.sql") === "20260912000000" &&
        extractMigrationVersion("not-a-migration.txt") === null
    )
  );

  results.push(
    check(
      "[P0-4] EXIT_OK/EXIT_DRIFT/EXIT_CHECK_FAILEDが判別可能な別々の値である(drift確定と検証不能を混同しない)",
      new Set<number>([EXIT_OK, EXIT_DRIFT, EXIT_CHECK_FAILED]).size === 3
    )
  );

  {
    const localVersions = getLocalMigrationVersions();

    results.push(
      check(
        "[P0-4] getLocalMigrationVersions()が実際のsupabase/migrations/を読み、新設した2件(20260913000000/20260914000000)を含む全migrationを検出する",
        localVersions.includes("20260913000000") &&
          localVersions.includes("20260914000000") &&
          localVersions.length >= 23
      )
    );
  }

  // secret出力 = 0(このscript自身がSUPABASE_SERVICE_ROLE_KEY等の値を
  // 一切参照・出力していないことをsource-levelで確認する)。
  {
    const scriptSource = readRepoFile("scripts/checkMigrationDrift.ts");

    results.push(
      check(
        "[P0-4] checkMigrationDrift.ts自身はSUPABASE_SERVICE_ROLE_KEYの値を一切console出力しない(存在有無のメッセージのみ)",
        !/console\.(log|error|warn)\([^)]*process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(scriptSource)
      )
    );
  }

  return summarize("security/preLiveSecP0", results);

}
