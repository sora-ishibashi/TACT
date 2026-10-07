import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = process.cwd();
const globals = readFileSync(resolve(root, "app/globals.css"), "utf8");
const appShell = readFileSync(resolve(root, "components/shell/AppShell.tsx"), "utf8");
const peek = readFileSync(resolve(root, "components/shell/DetailPeek.tsx"), "utf8");
const presentationState = readFileSync(resolve(root, "components/shell/PresentationState.tsx"), "utf8");
const login = readFileSync(resolve(root, "app/login/page.tsx"), "utf8");
const inspector = readFileSync(resolve(root, "components/runs/ExecutionInspector.tsx"), "utf8");
const icons = readFileSync(resolve(root, "components/icons/RunsIcons.tsx"), "utf8");

for (const token of ["base", "surface", "raised", "text", "text-secondary", "muted", "border", "interactive", "selected", "success", "warning", "danger", "info", "focus"]) {
  assert.match(globals, new RegExp(`--runs-${token}:`), `missing semantic token: ${token}`);
}
assert.match(globals, /prefers-color-scheme:\s*dark/);
assert.match(globals, /prefers-reduced-motion:\s*reduce/);
assert.match(appShell, /min-\[1200px\]:static/);
assert.match(peek, /md:w-\[min\(480px/);
assert.match(peek, /aria-modal="true"/);
assert.match(presentationState, /aria-busy/);
assert.match(presentationState, /animate-pulse/);
assert.match(login, /<Field label="メールアドレス"/);
assert.match(login, /<Field label="パスワード"/);
assert.doesNotMatch(login, /style=\{/);

function sourceFiles(directory: string): string[] {
  assert.match(inspector, /label="\\u7d50\\u679c"/);
  assert.match(inspector, /label="\\u30a2\\u30af\\u30b7\\u30e7\\u30f3"/);
  assert.match(inspector, /label="\\u5bfe\\u8c61"/);
  assert.match(inspector, /space-y-4/);
  assert.match(icons, /CloseIcon[\s\S]*strokeWidth=\{2\}/);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

const sources = [...sourceFiles(resolve(root, "app")), ...sourceFiles(resolve(root, "components"))];
for (const file of sources) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i, `direct color remains in ${file}`);
  assert.doesNotMatch(source, /text-\[(?:10|11)px\]/, `sub-12px text remains in ${file}`);
}

console.log("PASS SOR-259 UI technique convergence");
