import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { createSeededDatabase, verifyDatabase } from "./lib/database.mjs";
import { assertRuntimeEnvironmentIsIsolated, parsePort } from "./lib/guards.mjs";
import { controlTokenPath, databasePath, LOOPBACK_HOST, pidPath, runtimeDir } from "./lib/paths.mjs";

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function seed() {
  createSeededDatabase(databasePath);
  const result = verifyDatabase(databasePath);
  if (!result.ok) throw new Error(`Seed verification failed: ${result.errors.join(", ")}`);
  return result;
}

function verifyOrSeed() {
  if (!existsSync(databasePath)) return seed();
  const result = verifyDatabase(databasePath);
  if (!result.ok) throw new Error(`Existing database is invalid; run reset: ${result.errors.join(", ")}`);
  return result;
}

async function start() {
  assertRuntimeEnvironmentIsIsolated();
  const port = parsePort(process.env.SOR142_PORT);
  mkdirSync(runtimeDir, { recursive: true });
  verifyOrSeed();

  const controlToken = randomBytes(32).toString("hex");
  writeFileSync(controlTokenPath, controlToken, { encoding: "utf8", mode: 0o600 });

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const verification = verifyDatabase(databasePath);
      writeJson(response, verification.ok ? 200 : 500, {
        ok: verification.ok,
        environment: "local-only",
        host: LOOPBACK_HOST,
        fixtureVersion: verification.fixtureVersion,
        fixtureSha256: verification.fixtureSha256,
        counts: verification.counts,
        errors: verification.errors,
      });
      return;
    }

    if (request.method === "POST" && (request.url === "/reset" || request.url === "/shutdown")) {
      if (request.headers["x-sor142-control-token"] !== controlToken) {
        writeJson(response, 403, { ok: false, error: "invalid_control_token" });
        return;
      }

      if (request.url === "/reset") {
        try {
          const verification = seed();
          writeJson(response, 200, { ok: true, counts: verification.counts, fixtureSha256: verification.fixtureSha256 });
        } catch (error) {
          writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "reset_failed" });
        }
        return;
      }

      writeJson(response, 200, { ok: true });
      server.close(() => cleanupAndExit(0));
      return;
    }

    writeJson(response, 404, { ok: false, error: "not_found" });
  });

  function cleanupAndExit(code) {
    rmSync(pidPath, { force: true });
    rmSync(controlTokenPath, { force: true });
    process.exit(code);
  }

  server.on("error", (error) => {
    console.error(`[sor142] runtime error: ${error.message}`);
    cleanupAndExit(1);
  });

  server.listen(port, LOOPBACK_HOST, () => {
    writeFileSync(pidPath, `${process.pid}\n`, "utf8");
    console.log(`[sor142] local runtime ready at http://${LOOPBACK_HOST}:${port}`);
  });

  process.on("SIGINT", () => server.close(() => cleanupAndExit(0)));
  process.on("SIGTERM", () => server.close(() => cleanupAndExit(0)));
}

assertRuntimeEnvironmentIsIsolated();
const mode = process.argv[2] ?? "start";

if (mode === "--reset-only") {
  const result = seed();
  console.log(JSON.stringify(result));
} else if (mode === "--verify-only") {
  const result = verifyDatabase(databasePath);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} else if (mode === "start") {
  await start();
} else {
  throw new Error(`Unknown runtime mode: ${mode}`);
}
