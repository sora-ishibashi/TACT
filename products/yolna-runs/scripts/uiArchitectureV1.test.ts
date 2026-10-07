import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const shell = read("components/shell/AppShell.tsx");
const secondary = read("components/shell/SecondarySidebar.tsx");
const shellContainers = read("components/shell/ShellContainers.tsx");
const management = read("components/runs/ManagementSidebar.tsx");
const runsSection = read("components/runs/RunsSection.tsx");
const inspector = read("components/runs/ExecutionInspector.tsx");
const attention = read("components/runs/AttentionInbox.tsx");
const icons = read("components/icons/RunsIcons.tsx");
const home = read("components/runs/HomeView.tsx");
const connectionObservation = read("components/runs/ConnectionObservationView.tsx");
const agentManagement = read("components/runs/AgentManagementView.tsx");
const filterSheet = read("components/runs/ActivityFilterSheet.tsx");

for (const destination of [
  '{ id: "home", label: "ホーム"',
  '{ id: "work", label: "Work"',
  '{ id: "attention", label: "要確認"',
  '{ id: "activity", label: "実行記録"',
  '{ id: "management", label: "管理"',
]) assert.match(shell, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.match(shell, /label="設定"/);
assert.doesNotMatch(shell, /label: "(?:AI|権限|接続|観測|分析)"/);
assert.match(shell, /min-\[1200px\]:static/);
assert.match(shell, /fixed inset-0 z-40/);
assert.match(shell, /focus-visible:ring-2/);
assert.match(shell, /ShellLayoutMode = "wide" \| "compact" \| "narrow"/);
assert.match(shell, /ShellOverlay = "none" \| "primary" \| "secondary" \| "peek"/);
assert.match(shell, /setOverlay\(next\)/);
assert.match(shell, /overlay === "primary"/);

for (const subsection of ["agent", "permission", "connection", "observation"]) {
  assert.match(management, new RegExp(`id: "${subsection}"`));
}
assert.match(management, /title="管理"/);
assert.match(secondary, /-translate-x-full/);
assert.doesNotMatch(shellContainers, /lg:static/);
assert.match(secondary, /min-\[1200px\]:static/);
assert.match(secondary, /persistentWide \|\| overlay === "secondary"/);
assert.match(secondary, /openOverlay\("secondary"/);

assert.match(runsSection, /section === "management" && <ManagementSidebar/);
assert.match(runsSection, /mode=\{managementSection\}/);
assert.doesNotMatch(runsSection, /<AgentSidebar|<PermissionSidebar|<ConnectionObservationSidebar/);

const orderedLabels = ["結果", "アクション", "AI", "Work", "時刻", "対象", "依頼元"];
let cursor = -1;
for (const label of orderedLabels) {
  const next = inspector.indexOf(`label="${label}"`, cursor + 1);
  assert.ok(next > cursor, `inspector label is missing or out of order: ${label}`);
  cursor = next;
}
assert.match(inspector, /権限・監査情報/);
assert.match(inspector, /技術ディテール/);

assert.match(attention, /attentionReviewPresentation\(item\)/);
assert.match(attention, /attentionPrimaryAction\(item\)/);
assert.match(attention, /実行は完了しています。内容を確認してください。/);
assert.doesNotMatch(attention, /attentionReasonJapaneseExplanation/);
assert.match(icons, /CloseIcon[\s\S]*strokeWidth=\{2\}/);
assert.match(icons, /SettingsIcon[\s\S]*M6\.1 2\.3h3\.8/);
assert.match(icons, /FilterIcon/);
assert.match(home, /<h1 className="sr-only">ホーム<\/h1>/);
assert.doesNotMatch(runsSection, /section === "home" \? "ホーム"/);
assert.match(runsSection, /aria-label="フィルタ"/);
assert.match(runsSection, /<FilterIcon \/>/);
assert.match(runsSection, /<ActivityFilterSheet open=\{activityFilterOpen\}/);
assert.doesNotMatch(runsSection, /section === "activity" && <SecondarySidebar/);
assert.match(filterSheet, /absolute inset-y-0 right-0/);
assert.match(filterSheet, /if \(!open\) return null/);
assert.match(filterSheet, /event\.key === "Escape"/);
assert.match(runsSection, /activityFilterButtonRef\.current\?\.focus\(\)/);
assert.match(connectionObservation, /const isObservation = props.mode === "observation"/);
assert.match(connectionObservation, /\{isObservation && <Section title="Capture Gap履歴"/);
assert.match(agentManagement, /現在確認できる追加メタデータはありません。/);

console.log("PASS SOR-262 UI architecture v1 contract");
