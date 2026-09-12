// Server-only, redacted diagnostics for the Slack background boundary.
// This is neither a user-facing formatter nor an audit payload.

const REDACTED = "[redacted]";
const MESSAGE_MAX_LENGTH = 500;
const STACK_MAX_LENGTH = 2_000;

export type SlackBackgroundExecutionStage =
  | "approval_detection"
  | "approval_decision"
  | "conversation_context"
  | "conversation_intake"
  | "slack_action_delivery";

export interface SlackBackgroundFailureDiagnostic {
  stage: SlackBackgroundExecutionStage;
  errorName: string;
  message: string;
  thrownType?: string;
  thrownValueSummary?: string;
  name?: string;
  code?: string;
  details?: string;
  hint?: string;
  status?: string;
  statusCode?: string;
  error?: string;
  type?: string;
  keys?: string[];
  causeName?: string;
  causeMessage?: string;
  stack?: string;
}

const SAFE_NON_ERROR_FIELDS = [
  "name",
  "message",
  "code",
  "details",
  "hint",
  "status",
  "statusCode",
  "error",
  "type",
] as const;

type SafeNonErrorField = typeof SAFE_NON_ERROR_FIELDS[number];

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function redactKnownValues(text: string, knownSensitiveValues: readonly string[]): string {
  let sanitized = text;

  for (const value of [...knownSensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(value).join(REDACTED);
  }

  return sanitized;
}

function sanitizeDiagnosticText(
  text: string,
  knownSensitiveValues: readonly string[],
  maxLength = MESSAGE_MAX_LENGTH
): string {
  const sanitized = redactKnownValues(text, knownSensitiveValues)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\bAuthorization\s*[:=]\s*.+/gi, `Authorization: ${REDACTED}`)
    .replace(
      /\b(access_token|refresh_token|api[_-]?key|client_secret|password|credential|provider[_-]?connected[_-]?account[_-]?id|connected[_-]?account[_-]?id|connection[_-]?id|account[_-]?id)\b\s*[:=]\s*["']?[^"'\s,}]+["']?/gi,
      (_match, key: string) => `${key}=${REDACTED}`
    )
    .replace(/([?&](?:access_token|refresh_token|api[_-]?key|client_secret|connection[_-]?id|account[_-]?id)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bca_[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);

  return truncate(sanitized, maxLength);
}

function toSafeErrorName(error: Error, knownSensitiveValues: readonly string[]): string {
  const name = sanitizeDiagnosticText(error.name || "Error", knownSensitiveValues);
  return name || "Error";
}

function safePrimitiveSummary(value: unknown, knownSensitiveValues: readonly string[]): string {
  try {
    return sanitizeDiagnosticText(String(value), knownSensitiveValues);
  } catch {
    return "[unprintable]";
  }
}

function readSafeScalarField(
  value: object,
  key: SafeNonErrorField,
  knownSensitiveValues: readonly string[]
): string | undefined {
  try {
    const candidate = (value as Record<string, unknown>)[key];
    if (
      typeof candidate !== "string" &&
      typeof candidate !== "number" &&
      typeof candidate !== "boolean" &&
      candidate !== null
    ) {
      return undefined;
    }
    return sanitizeDiagnosticText(String(candidate), knownSensitiveValues);
  } catch {
    return undefined;
  }
}

function buildSafeNonErrorDiagnostic(
  error: unknown,
  stage: SlackBackgroundExecutionStage,
  knownSensitiveValues: readonly string[]
): SlackBackgroundFailureDiagnostic {
  if (error === null) {
    return {
      stage,
      errorName: "NonErrorThrown",
      message: "A non-Error null value was thrown.",
      thrownType: "null",
      thrownValueSummary: "null",
    };
  }

  if (typeof error !== "object") {
    const summary = safePrimitiveSummary(error, knownSensitiveValues);
    return {
      stage,
      errorName: "NonErrorThrown",
      message: summary || "A non-Error primitive value was thrown.",
      thrownType: typeof error,
      thrownValueSummary: summary,
    };
  }

  const diagnostic: SlackBackgroundFailureDiagnostic = {
    stage,
    errorName: "NonErrorThrown",
    message: "A non-Error object was thrown.",
    thrownType: "object",
  };
  const keys: string[] = [];

  for (const key of SAFE_NON_ERROR_FIELDS) {
    const field = readSafeScalarField(error, key, knownSensitiveValues);
    if (field === undefined) continue;
    keys.push(key);
    if (key === "message") {
      diagnostic.message = field || "A non-Error object was thrown.";
    } else {
      diagnostic[key] = field;
    }
  }

  diagnostic.thrownValueSummary = keys.length > 0
    ? `object with diagnostic fields: ${keys.join(", ")}`
    : "object without supported diagnostic fields";
  if (keys.length > 0) diagnostic.keys = keys;
  return diagnostic;
}

export function buildSafeSlackBackgroundFailureDiagnostic(
  error: unknown,
  stage: SlackBackgroundExecutionStage,
  knownSensitiveValues: readonly string[] = []
): SlackBackgroundFailureDiagnostic {
  if (!(error instanceof Error)) {
    return buildSafeNonErrorDiagnostic(error, stage, knownSensitiveValues);
  }

  const diagnostic: SlackBackgroundFailureDiagnostic = {
    stage,
    errorName: toSafeErrorName(error, knownSensitiveValues),
    message: sanitizeDiagnosticText(error.message || "Error without a message.", knownSensitiveValues),
  };

  if (error.cause instanceof Error) {
    diagnostic.causeName = toSafeErrorName(error.cause, knownSensitiveValues);
    diagnostic.causeMessage = sanitizeDiagnosticText(
      error.cause.message || "Error cause without a message.",
      knownSensitiveValues
    );
  }

  if (typeof error.stack === "string" && error.stack.length > 0) {
    diagnostic.stack = sanitizeDiagnosticText(error.stack, knownSensitiveValues, STACK_MAX_LENGTH);
  }

  return diagnostic;
}
