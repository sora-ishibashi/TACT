import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // STEP32: pdf-parse(内部でpdfjs-distのworkerを動的import)は
  // Server Componentsバンドラー(Turbopack)に取り込まれると、
  // worker用チャンクへの相対パス解決が壊れて失敗する
  // ("Setting up fake worker failed")。ネイティブのNode.js requireで
  // 読み込ませることで回避する。
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
