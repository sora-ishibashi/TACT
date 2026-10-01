#!/usr/bin/env bash
# =========================
# Standalone Runs — Clean Install + Build Check (SOR-135 Phase 2)
# =========================
#
# CI building blocks 4/5 (section14指示、section11「独立Install Test」
# 最重要Acceptance Criteria). Copies ONLY products/yolna-runs and the
# packages/ directories it depends on into a throwaway temp directory
# (no root Yolna application, no core/tact-work, core/tact-bot,
# core/tact-orchestrator, core/llm, core/workflow, core/agents, core/brain,
# Research/Core/Code UI, Yolna API routes — nothing outside
# packages/execution-contract, packages/runs-core, products/yolna-runs),
# then runs `npm ci` followed by `npm run build` there. Both must succeed
# for this script to pass.
#
# Usage: bash scripts/verify/standaloneCleanInstall.sh
# Exit code 0 = both npm ci and npm run build succeeded in isolation.
# Exit code 1 = either step failed, or the isolated tree is missing a file
#   this app actually needs (which is itself a real finding: it means the
#   app secretly depends on something outside its declared boundary).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLEANROOM="$(mktemp -d)"

cleanup() {
  rm -rf "$CLEANROOM"
}
trap cleanup EXIT

echo "[standaloneCleanInstall] isolated copy target: $CLEANROOM"

mkdir -p "$CLEANROOM/packages" "$CLEANROOM/products"

# rsync is not guaranteed on every CI image; use cp -r + explicit node_modules/.next
# removal (rather than an exclude pattern) so this works with a plain cp too.
cp -r "$REPO_ROOT/packages/execution-contract" "$CLEANROOM/packages/execution-contract"
cp -r "$REPO_ROOT/packages/runs-core" "$CLEANROOM/packages/runs-core"
cp -r "$REPO_ROOT/products/yolna-runs" "$CLEANROOM/products/yolna-runs"

rm -rf \
  "$CLEANROOM/packages/execution-contract/node_modules" \
  "$CLEANROOM/packages/runs-core/node_modules" \
  "$CLEANROOM/products/yolna-runs/node_modules" \
  "$CLEANROOM/products/yolna-runs/.next"

echo "[standaloneCleanInstall] isolated tree (excluding node_modules):"
find "$CLEANROOM" -not -path "*/node_modules*" | sort

# Not an npm workspace: @tact/execution-contract and @tact/runs-core are
# plain `file:` dependencies, installed as symlinks. A symlinked package's
# own imports resolve node_modules starting from its REAL path
# (packages/runs-core), which is not an ancestor of
# products/yolna-runs/node_modules — so each package needs its own
# node_modules installed independently, or its own runtime imports
# (e.g. @supabase/supabase-js from packages/runs-core) fail to resolve.
echo "[standaloneCleanInstall] installing packages/execution-contract's own dependencies..."
(cd "$CLEANROOM/packages/execution-contract" && npm install)

echo "[standaloneCleanInstall] installing packages/runs-core's own dependencies..."
(cd "$CLEANROOM/packages/runs-core" && npm install)

echo "[standaloneCleanInstall] running npm ci in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && npm ci)

echo "[standaloneCleanInstall] running npm run build in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && npm run build)

echo "[standaloneCleanInstall] PASS: npm ci and npm run build both succeeded with zero Yolna application source tree present"
