import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const experimentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const fixturePath = join(experimentDir, "fixtures", "nexaworks.fixture.json");
export const schemaPath = join(experimentDir, "schema.sql");
export const runtimeDir = join(experimentDir, ".runtime");
export const databasePath = join(runtimeDir, "nexaworks.sqlite");
export const pidPath = join(runtimeDir, "runtime.pid");
export const controlTokenPath = join(runtimeDir, "control-token");
export const logPath = join(runtimeDir, "runtime.log");
export const runtimeEntryPath = join(experimentDir, "runtime.mjs");

export const DEFAULT_PORT = 43142;
export const LOOPBACK_HOST = "127.0.0.1";
