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

for (const subsection of ["agent", "permission", "connection", "observation"]) {
  assert.match(management, new RegExp(`id: "${subsection}"`));
}
assert.match(management, /title="管理"/);
assert.match(secondary, /-translate-x-full/);
assert.match(shellContainers, /lg:static/);
assert.match(secondary, /lg:translate-x-0/);
assert.match(secondary, /fixed inset-0 z-40/);
assert.match(secondary, /aria-expanded=\{open\}/);

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
assert.match(icons, /CloseIcon[\s\S]*strokeWidth=\{2\}/);

console.log("PASS SOR-262 UI architecture v1 contract");
