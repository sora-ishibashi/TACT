// =========================
// TACT Runs Core — Import Probe (SOR-135 Phase 1)
// =========================
//
// Standalone probe invoked as a child process (never imported directly)
// by tests/tact/execution/runsCoreImportIsolation.test.ts. Its only job is
// to import core/tact-execution and core/tact-runs-view and exit 0 if that
// succeeds, or let Node's default uncaught-exception handling exit
// non-zero and print the error if it doesn't. Run in a fresh process with
// a caller-controlled env so the parent test can assert "this import
// succeeds with OPENAI_API_KEY/ANTHROPIC_API_KEY/COMPOSIO_API_KEY/
// TAVILY_API_KEY absent" without any of those keys, or any other test
// file's prior import of core/llm, contaminating the result.

import "@tact/runs-core/tact-execution";
import "@tact/runs-core/tact-runs-view";

console.log("[runsCoreImportProbe] ok");
