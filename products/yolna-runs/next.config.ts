import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SOR-135 Phase 2: @tact/execution-contract and @tact/runs-core are
  // local `file:` dependencies shipping raw TypeScript source, not
  // pre-compiled JS — Next.js does not transpile node_modules by default,
  // so without this they would fail to bundle.
  transpilePackages: ["@tact/execution-contract", "@tact/runs-core"],
  // Pin Turbopack's workspace root to the common ancestor of this app and
  // the `packages/*` directories its `file:` dependencies symlink to
  // (two levels up: products/yolna-runs -> ..). Without this, Turbopack
  // auto-detects the root from the nearest lockfile, which in an isolated
  // copy containing only packages/ + products/yolna-runs/ (the Phase 2
  // standalone install test's exact layout — no other lockfile exists
  // above it) would resolve to this app's own directory, outside which it
  // then refuses to follow the @tact/* symlinks at all.
  turbopack: {
    root: path.resolve(__dirname, "..", ".."),
  },
};

export default nextConfig;
