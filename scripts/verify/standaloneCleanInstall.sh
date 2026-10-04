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
# Research/Core/Code UI, Yolna API routes — only the two shared packages,
# the Runs product, and the product-neutral verification scripts), then runs
# locked installs, secret-boundary negatives, and canonical verify/security.
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

if [[ -n "${RUNS_NODE_BIN:-}" || -n "${RUNS_NPM_CLI:-}" ]]; then
  if [[ -z "${RUNS_NODE_BIN:-}" || -z "${RUNS_NPM_CLI:-}" ]]; then
    echo "[standaloneCleanInstall] FAIL: RUNS_NODE_BIN and RUNS_NPM_CLI must be set together"
    exit 1
  fi
  NPM_COMMAND=("$RUNS_NODE_BIN" "$RUNS_NPM_CLI")

  # Keep nested npm lifecycle commands on the same explicitly selected
  # runtime. Windows npm scripts otherwise resolve the machine-wide Node
  # executable even when npm itself was launched by a different node.exe.
  RUNTIME_BIN="$CLEANROOM/.runtime-bin"
  mkdir -p "$RUNTIME_BIN"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$RUNS_NODE_BIN" > "$RUNTIME_BIN/node"
  printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$RUNS_NODE_BIN" "$RUNS_NPM_CLI" > "$RUNTIME_BIN/npm"
  chmod +x "$RUNTIME_BIN/node" "$RUNTIME_BIN/npm"

  if command -v cygpath >/dev/null 2>&1; then
    NODE_BIN_WINDOWS="$(cygpath -w "$RUNS_NODE_BIN")"
    NPM_CLI_WINDOWS="$(cygpath -w "$RUNS_NPM_CLI")"
    printf '@"%s" %%*\r\n' "$NODE_BIN_WINDOWS" > "$RUNTIME_BIN/node.cmd"
    printf '@"%s" "%s" %%*\r\n' "$NODE_BIN_WINDOWS" "$NPM_CLI_WINDOWS" > "$RUNTIME_BIN/npm.cmd"
  fi

  export PATH="$RUNTIME_BIN:$PATH"
else
  NPM_COMMAND=(npm)
fi

echo "[standaloneCleanInstall] isolated copy target: $CLEANROOM"
echo "[standaloneCleanInstall] selected runtime: $(node --version), npm $("${NPM_COMMAND[@]}" --version)"

mkdir -p "$CLEANROOM/packages" "$CLEANROOM/products"

# Copy source/config/lockfiles without ever copying credentials, Vercel link
# state, installed dependencies, or build output into the clean room.
(cd "$REPO_ROOT" && tar -cf - \
  --exclude='*/node_modules' \
  --exclude='*/.next' \
  --exclude='*/.vercel' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*/supabase/.temp' \
  --exclude='*/supabase/.branches' \
  --exclude='*.tsbuildinfo' \
  packages/execution-contract packages/runs-core products/yolna-runs scripts/verify) | \
  (cd "$CLEANROOM" && tar -xf -)
cp "$REPO_ROOT/products/yolna-runs/.env.example" "$CLEANROOM/products/yolna-runs/.env.example"

if [[ -e "$CLEANROOM/products/yolna-runs/.vercel" ||
      -e "$CLEANROOM/products/yolna-runs/.env.local" ||
      -e "$CLEANROOM/products/yolna-runs/supabase/.temp" ||
      -e "$CLEANROOM/products/yolna-runs/supabase/.branches" ]]; then
  echo "[standaloneCleanInstall] FAIL: generated CLI state or local env material entered the clean room"
  exit 1
fi

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
(cd "$CLEANROOM/packages/execution-contract" && "${NPM_COMMAND[@]}" ci)

echo "[standaloneCleanInstall] installing packages/runs-core's own dependencies..."
(cd "$CLEANROOM/packages/runs-core" && "${NPM_COMMAND[@]}" ci)

echo "[standaloneCleanInstall] running npm ci in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && "${NPM_COMMAND[@]}" ci)

echo "[standaloneCleanInstall] testing the strict env boundary in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  "${NPM_COMMAND[@]}" run test:env)

echo "[standaloneCleanInstall] testing explicit development-mode env loading..."
(cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=development \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  "${NPM_COMMAND[@]}" run verify:env -- --mode=development)

NEGATIVE_LOG="$CLEANROOM/negative-build.log"
if (cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  CUSTOMER_SAAS_WRITE_TOKEN=synthetic-test-value \
  "${NPM_COMMAND[@]}" run build >"$NEGATIVE_LOG" 2>&1); then
  echo "[standaloneCleanInstall] FAIL: synthetic unknown credential did not stop the build"
  exit 1
fi
if grep -q '^> next build$' "$NEGATIVE_LOG"; then
  echo "[standaloneCleanInstall] FAIL: Next.js build started before the env validator rejected the synthetic credential"
  exit 1
fi
echo "[standaloneCleanInstall] PASS: synthetic CUSTOMER_SAAS_WRITE_TOKEN rejected before Next.js build"

assert_env_file_rejected() {
  local env_file="$1"
  local negative_log="$CLEANROOM/negative-${env_file//./-}.log"

  printf '%s\n' 'CUSTOMER_SAAS_WRITE_TOKEN=synthetic-test-value' > \
    "$CLEANROOM/products/yolna-runs/$env_file"

  if (cd "$CLEANROOM/products/yolna-runs" && env -i \
    PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
    SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
    "${NPM_COMMAND[@]}" run build >"$negative_log" 2>&1); then
    echo "[standaloneCleanInstall] FAIL: $env_file synthetic credential did not stop the build"
    exit 1
  fi
  rm "$CLEANROOM/products/yolna-runs/$env_file"

  if grep -q '^> next build$' "$negative_log"; then
    echo "[standaloneCleanInstall] FAIL: Next.js build started before $env_file was rejected"
    exit 1
  fi
  echo "[standaloneCleanInstall] PASS: $env_file synthetic credential rejected before Next.js build"
}

assert_env_file_rejected ".env.local"
assert_env_file_rejected ".env.production.local"

NEGATIVE_START_LOG="$CLEANROOM/negative-start.log"
if (cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  CUSTOMER_SAAS_WRITE_TOKEN=synthetic-test-value \
  "${NPM_COMMAND[@]}" start >"$NEGATIVE_START_LOG" 2>&1); then
  echo "[standaloneCleanInstall] FAIL: synthetic unknown credential did not stop startup"
  exit 1
fi
if grep -q '^> next start$' "$NEGATIVE_START_LOG"; then
  echo "[standaloneCleanInstall] FAIL: Next.js server started before the env validator rejected the synthetic credential"
  exit 1
fi
echo "[standaloneCleanInstall] PASS: prestart rejected the synthetic credential before Next.js startup"

echo "[standaloneCleanInstall] running canonical npm run verify in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  "${NPM_COMMAND[@]}" run verify)

echo "[standaloneCleanInstall] running canonical npm run security in isolation..."
(cd "$CLEANROOM/products/yolna-runs" && env -i \
  PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-not-a-real-key \
  SUPABASE_SERVICE_ROLE_KEY=synthetic-not-a-real-key \
  "${NPM_COMMAND[@]}" run security)

echo "[standaloneCleanInstall] PASS: locked installs plus canonical verify/security succeeded with zero Yolna application source tree present"
