// =========================
// check (Phase 20)
// =========================
//
// TACT Evaluation Harnessが共有する、最小限のassert/report補助。
// Jest/Vitest等の新しいtest frameworkは導入しない(Phase20 Step1で
// package.jsonにtest runnerが一切存在しないことを確認済み。全Phaseで
// 使ってきた「npx tsx <script>.ts」というde facto実行方法をそのまま
// 恒久ファイル化するだけであり、新しい実行基盤は増やさない)。
//
// 各TestFileはCheckResult[]を返すrun()をexportする。個々のcheck()は
// 例外を投げず、常にCheckResultを返す(1件の失敗が他のcheckの実行を
// 止めない)。

export interface CheckResult {

  // 例: "[Phase15] detectAmbiguity(\"調べて\") -> ambiguous=true"
  // Step6: どのPhase/Capabilityのための確認かがlabel自体から分かる
  // ようにする(専用のmetadata構造は増やさない、過剰なframework化の
  // 回避)。
  label: string;

  pass: boolean;

  detail?: string;

}

export function check(
  label: string,
  pass: boolean,
  detail?: string
): CheckResult {

  return { label, pass, detail };

}

export function summarize(
  suiteName: string,
  results: CheckResult[]
): { pass: number; fail: number } {

  let pass = 0;
  let fail = 0;

  for (const r of results) {

    if (r.pass) {
      pass++;
    } else {
      fail++;
    }

    const mark = r.pass ? "PASS" : "FAIL";
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  [${mark}] ${r.label}${detail}`);

  }

  console.log(`${suiteName}: ${pass} passed, ${fail} failed`);

  return { pass, fail };

}
