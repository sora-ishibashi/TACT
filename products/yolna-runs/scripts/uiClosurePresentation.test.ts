import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appShell = readFileSync(resolve(process.cwd(), "components/shell/AppShell.tsx"), "utf8");
const attentionInbox = readFileSync(resolve(process.cwd(), "components/runs/AttentionInbox.tsx"), "utf8");

assert.match(appShell, /min-\[1200px\]:static/);
assert.match(appShell, /min-\[1200px\]:hidden/);
assert.match(attentionInbox, /attentionReviewPresentation/);
assert.match(attentionInbox, /権限評価/);
console.log("PASS SOR-239 UI closure presentation");
