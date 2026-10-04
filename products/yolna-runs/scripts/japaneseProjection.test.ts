import assert from "node:assert/strict";
import { japaneseProjection } from "../lib/japaneseProjection";
const cases: Array<[string, string]> = [["Work", "仕事"], ["Execution", "実行"], ["Activity", "実行記録"], ["Attention", "要確認"], ["Principal", "依頼元"], ["Delegation", "AIへの委任"], ["Agent", "AI"], ["Permission", "権限"], ["Outcome", "結果"], ["Artifact", "成果物"], ["Work Correlation", "仕事への紐づけ"], ["UNASSIGNED", "未割り当て"], ["AMBIGUOUS", "判断が必要"], ["CORRELATED", "紐づけ済み"], ["MANUALLY_ASSIGNED", "人が設定"], ["MATCH", "許可範囲内"], ["MISMATCH", "登録ルールと不一致"], ["UNKNOWN", "判定できません"], ["APPROVAL_REQUIRED", "承認待ち"], ["NOT_EVALUATED", "未判定"], ["Capture Gap", "観測欠損"], ["INLINE", "経路内観測"], ["INSTRUMENTED", "計測連携"], ["RECONCILED", "事後照合"]];
for (const [input, expected] of cases) assert.equal(japaneseProjection(input), expected);
assert.equal(japaneseProjection("FUTURE_VALUE"), "FUTURE_VALUE");
console.log(`PASS japanese projection (${cases.length} mappings)`);
