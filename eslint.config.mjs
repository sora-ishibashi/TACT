import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // SOR-135 Phase 2: products/yolna-runs is a fully independent Next.js
    // application with its own eslint.config.mjs (and its own .next/**
    // build output) — lint it separately via `cd products/yolna-runs &&
    // npx eslint`. Without this, eslint-config-next's default .next/**
    // ignore (relative to repo root) does not reach a nested app's own
    // .next/ directory, so a standalone build's compiled output gets
    // linted as source here too.
    "products/**",
  ]),
]);

export default eslintConfig;
