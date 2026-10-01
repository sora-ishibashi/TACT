import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // STEP32: pdf-parse(内部でpdfjs-distのworkerを動的import)は
  // Server Componentsバンドラー(Turbopack)に取り込まれると、
  // worker用チャンクへの相対パス解決が壊れて失敗する
  // ("Setting up fake worker failed")。ネイティブのNode.js requireで
  // 読み込ませることで回避する。
  serverExternalPackages: ["pdf-parse"],
  // SOR-135 Phase 2: @tact/execution-contract and @tact/runs-core are
  // local `file:` dependencies (packages/execution-contract,
  // packages/runs-core) shipping raw TypeScript source, not pre-compiled
  // JS — Next.js does not transpile node_modules by default, so without
  // this they would fail to bundle.
  transpilePackages: ["@tact/execution-contract", "@tact/runs-core"],
};

export default nextConfig;
