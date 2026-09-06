// =========================
// TACT Work — Integration/Approval Task Lifecycle Monotonicity
// (静的確認、Architecture Migration Phase C2.1c-a-test)
// =========================
//
// 目的: Phase C2.1c-aで除去した「completed→running」のような、
// terminal stateから非terminalへ戻すTask status rollbackが、
// Integration/Approval pathへ再度混入していないことを、実コードの
// ソーステキストに対する静的検査(grep相当)で確認する。既存の
// core/tact-integration/gateway.test.ts(@composio/core importの
// scope確認)と同じ手法。
//
// 対象範囲: 今回のscope(Integration/Approval path)に限定する
// (絶対条件: repository全体に汎用状態機械を追加しない、対象は
// core/tact-work/execution.ts・core/tact-work/approval.ts・
// core/tact-integration/execution.ts・core/tact-integration/
// propose.tsの4fileのみ)。
//
// 静的検査の性質上、「Xという文字列のstatusへの更新呼び出しが
// 存在するかどうか」までしか機械的に確認できない
// (呼び出し時点のTask実際の値は動的な情報のため)。遷移元の実際の
// 値については、tests/tact/integration/execution.test.ts・
// tests/tact/work/approval.test.tsの、Task status update historyを
// 順序ごと厳密にassertする回帰テスト(Phase C2.1c-a-testで追加)が
// 補完する。
//
// 追記(Phase C2.1c-a-fix): 当初はcore/tact-integration/execution.ts
// が「Task事前stateを読まないこと」を安全性の根拠としていたが、
// これはむしろ「誤ったTask stateからでもrunningへ遷移できてしまう」
// 弱点だったと判明した。現在はこの境界自身がlistTasksForWork()で
// Task事前stateを確認し、pending以外なら新規executionを開始しない
// (task_not_executable)という、逆方向のprecondition invariantを
// 持つ。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const TARGET_FILES = [
  "../../../core/tact-work/execution.ts",
  "../../../core/tact-work/approval.ts",
  "../../../core/tact-integration/execution.ts",
  "../../../core/tact-integration/propose.ts",
];

function readTarget(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const sources = TARGET_FILES.map((path) => ({ path, content: readTarget(path) }));

  // Phase C2.1b-fix/C2.1b-fix2で発見・除去した、まさにこの回帰
  // パターン(Task statusをterminal状態から"pending"へ書き戻す)が
  // 4fileのどこにも再混入していないことを確認する。
  {
    const offenders = sources.filter(({ content }) =>
      /updateTaskStatus\([^)]*["']pending["']/.test(content)
    );

    results.push(
      check(
        "[静的確認] Integration/Approval path 4fileに、updateTaskStatus(..., \"pending\")という呼び出しが一切存在しない(completed/failed等のterminal状態からpendingへ書き戻すrollbackを再導入しない)",
        offenders.length === 0,
        offenders.map((o) => o.path).join(", ")
      )
    );
  }

  // Architecture Migration Phase C2.1c-a-fix: 以前はここで
  // 「core/tact-integration/execution.tsはTask事前stateを読まない」
  // ことを根拠として確認していたが、これは逆に「callerが誤ったTask
  // stateで呼んでもrunningへ遷移できてしまう」という弱点だった。
  // 修正後は逆に、この境界がdedup確認より後・Run作成より前に
  // listTasksForWork()でTaskの現在stateを取得し、pending以外なら
  // 停止する(task_not_executable)という構造になっていることを確認
  // する。実際の遷移順序・provider call回数のassertionは
  // tests/tact/integration/execution.test.tsのbehavior test
  // (Case1〜7)側で行うため、ここでは「Task state読み取りの経路
  // 自体が存在する」ことだけを静的に確認する(過度なsource文字列
  // 検査は増やさない)。
  {
    const executionSource = sources.find((s) => s.path.endsWith("tact-integration/execution.ts"))!;

    const readsTaskStateBeforeRunning = /listTasksForWork\(/.test(executionSource.content) &&
      /task_not_executable/.test(executionSource.content);

    results.push(
      check(
        "[静的確認] core/tact-integration/execution.tsは新規external execution開始前にlistTasksForWork()でTaskの現在stateを取得し、pending以外(completed/failed/cancelled/running)ならtask_not_executableとして安全に停止する経路を持つ",
        readsTaskStateBeforeRunning
      )
    );
  }

  // core/tact-integration/propose.tsが、そもそもupdateTaskStatusと
  // いう名前を一切import/参照していないことを確認する(型構造上
  // Task statusを更新する手段が無いことのfile単位での再確認、
  // tests/tact/integration/propose.test.tsのDeps構造確認と対になる)。
  {
    const proposeSource = sources.find((s) => s.path.endsWith("tact-integration/propose.ts"))!;

    results.push(
      check(
        "[静的確認] core/tact-integration/propose.tsはupdateTaskStatusという識別子を一切参照しない(Task statusを更新する手段を持たない)",
        !proposeSource.content.includes("updateTaskStatus")
      )
    );
  }

  return summarize("work/taskLifecycleMonotonicity", results);

}
