const deploymentLabels = [
  "VERCEL_ENV",
  "TACT_ENV",
  "YOLNA_ENV",
  "RUNS_ENV",
  "APP_ENV",
  "NEXT_PUBLIC_APP_ENV",
];

const forbiddenDeploymentValues = new Set(["production", "prod", "staging", "stage", "preview"]);
const credentialNamePattern = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|SERVICE_ROLE|OAUTH)/i;

function isLoopbackUrl(rawValue) {
  try {
    const url = new URL(rawValue);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function assertParentEnvironmentSafe(env = process.env) {
  for (const name of deploymentLabels) {
    const value = env[name]?.trim().toLowerCase();
    if (value && forbiddenDeploymentValues.has(value)) {
      throw new Error(`${name}=${value} is not a local environment. Refusing SOR-142 execution.`);
    }
  }

  for (const [name, rawValue] of Object.entries(env)) {
    const value = rawValue?.trim();
    if (!value) continue;

    if (/SUPABASE.*URL|NEXT_PUBLIC_SUPABASE_URL/i.test(name) && !isLoopbackUrl(value)) {
      throw new Error(`${name} is not loopback. Refusing to target hosted Supabase.`);
    }

    if (/SUPABASE.*PROJECT.*REF/i.test(name) && !/^local(?:host)?$/i.test(value)) {
      throw new Error(`${name} names a non-local project. Refusing SOR-142 execution.`);
    }
  }
}

export function buildIsolatedRuntimeEnvironment(parentEnv = process.env, port) {
  const allowedHostNames = ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];
  const isolated = {};

  for (const name of allowedHostNames) {
    if (parentEnv[name]) isolated[name] = parentEnv[name];
  }

  isolated.NODE_ENV = "test";
  isolated.SOR142_ENV = "local";
  isolated.SOR142_PORT = String(port);
  return isolated;
}

export function assertRuntimeEnvironmentIsIsolated(env = process.env) {
  if (env.SOR142_ENV !== "local" || env.NODE_ENV !== "test") {
    throw new Error("SOR-142 runtime requires the isolated local environment allowlist.");
  }

  for (const [name, rawValue] of Object.entries(env)) {
    if (!rawValue) continue;
    if (credentialNamePattern.test(name)) {
      throw new Error(`Credential-like variable ${name} reached the SOR-142 runtime.`);
    }
  }

  assertParentEnvironmentSafe(env);
}

export function parsePort(rawValue) {
  const port = rawValue === undefined ? 43142 : Number(rawValue);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("SOR142_PORT must be an integer between 1024 and 65535.");
  }
  return port;
}
