import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { assertParentEnvironmentSafe, buildIsolatedRuntimeEnvironment, parsePort } from "./lib/guards.mjs";
import { controlTokenPath, databasePath, LOOPBACK_HOST, logPath, pidPath, runtimeDir, runtimeEntryPath } from "./lib/paths.mjs";

const command = process.argv[2];
const port = parsePort(process.env.SOR142_PORT);
const baseUrl = `http://${LOOPBACK_HOST}:${port}`;

assertParentEnvironmentSafe();

async function request(path, options = {}) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(600) });
    const body = await response.json();
    return { reachable: true, status: response.status, body };
  } catch {
    return { reachable: false };
  }
}

function isolatedEnv() {
  return buildIsolatedRuntimeEnvironment(process.env, port);
}

function runOneShot(mode) {
  const result = spawnSync(process.execPath, [runtimeEntryPath, mode], {
    cwd: process.cwd(),
    env: isolatedEnv(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${mode} failed`).trim());
  }
  return JSON.parse(result.stdout.trim());
}

async function start() {
  const existing = await request("/health");
  if (existing.reachable && existing.body?.ok) {
    console.log(JSON.stringify({ ok: true, alreadyRunning: true, ...existing.body }, null, 2));
    return;
  }

  mkdirSync(runtimeDir, { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [runtimeEntryPath, "start"], {
    cwd: process.cwd(),
    env: isolatedEnv(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await request("/health");
    if (health.reachable && health.body?.ok) {
      console.log(JSON.stringify({ ok: true, started: true, credentialsForwarded: false, ...health.body }, null, 2));
      return;
    }
  }

  const logTail = existsSync(logPath) ? readFileSync(logPath, "utf8").split(/\r?\n/).slice(-8).join("\n") : "no runtime log";
  throw new Error(`Runtime did not become healthy. Log tail:\n${logTail}`);
}

function readControlToken() {
  if (!existsSync(controlTokenPath)) throw new Error("Runtime control token is missing; the runtime may not be running.");
  return readFileSync(controlTokenPath, "utf8").trim();
}

async function reset() {
  const health = await request("/health");
  if (health.reachable) {
    const result = await request("/reset", { method: "POST", headers: { "x-sor142-control-token": readControlToken() } });
    if (!result.reachable || result.status !== 200 || !result.body?.ok) throw new Error("Running runtime rejected reset.");
    console.log(JSON.stringify({ ok: true, reset: true, runtimeRunning: true, ...result.body }, null, 2));
    return;
  }

  const result = runOneShot("--reset-only");
  console.log(JSON.stringify({ ok: true, reset: true, runtimeRunning: false, ...result }, null, 2));
}

async function verify() {
  const database = runOneShot("--verify-only");
  const health = await request("/health");
  console.log(JSON.stringify({
    ok: database.ok && (!health.reachable || health.body?.ok === true),
    database,
    runtime: health.reachable ? health.body : { running: false },
    isolation: { host: LOOPBACK_HOST, credentialsForwarded: false, databasePath },
  }, null, 2));
}

async function stop() {
  const health = await request("/health");
  if (!health.reachable) {
    rmSync(pidPath, { force: true });
    rmSync(controlTokenPath, { force: true });
    console.log(JSON.stringify({ ok: true, alreadyStopped: true }, null, 2));
    return;
  }

  const result = await request("/shutdown", { method: "POST", headers: { "x-sor142-control-token": readControlToken() } });
  if (!result.reachable || result.status !== 200 || !result.body?.ok) throw new Error("Runtime rejected shutdown.");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await request("/health");
    if (!current.reachable) {
      console.log(JSON.stringify({ ok: true, stopped: true, processRemaining: false }, null, 2));
      return;
    }
  }
  throw new Error("Runtime still responds after shutdown request.");
}

if (command === "start") await start();
else if (command === "reset") await reset();
else if (command === "verify") await verify();
else if (command === "stop") await stop();
else {
  console.error("Usage: node experiments/sor142-nexaworks-reality-test/cli.mjs <start|verify|reset|stop>");
  process.exitCode = 2;
}
