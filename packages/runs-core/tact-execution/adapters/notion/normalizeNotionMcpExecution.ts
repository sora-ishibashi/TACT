import type { CaptureExecutionInput, ExecutionActorKind } from "../../types";
import type { ExecutionAdapterNormalizeResult } from "../types";

export const NOTION_MCP_ADAPTER_VERSION = "notion-mcp-v1";

export type NotionMcpCanonicalOperation =
  | "READ"
  | "CREATE_PAGE"
  | "UPDATE_PAGE"
  | "DELETE_PAGE";

export type NotionMcpSafeErrorCode =
  | "notion_mcp_tool_failed"
  | "notion_rate_limited"
  | "notion_not_found"
  | "notion_permission_denied";

const NOTION_MCP_SAFE_ERROR_CODES: readonly NotionMcpSafeErrorCode[] = [
  "notion_mcp_tool_failed",
  "notion_rate_limited",
  "notion_not_found",
  "notion_permission_denied",
];

export interface NotionMcpInvocationObservation {
  /** The TACT tenant resolved by the MCP host. It is never derived from Notion input. */
  userId: string;
  actorKind: ExecutionActorKind;
  /** The authenticated principal, when the host has one. */
  principalId?: string | null;
  /** The executing agent, when the host has one. */
  agentId?: string | null;
  connectionId?: string | null;
  /** A non-secret Notion account reference, if the host has one. */
  accountRef?: string | null;
  /** An id supplied by the MCP host; it is the capture idempotency key. */
  invocationId: string;
  externalRequestId?: string | null;
  /**
   * SOR-53 Path A(explicit workId propagation): the MCP client's own
   * claim of which Work this invocation belongs to. Never trusted blindly
   * here — normalizeNotionMcpInvocationToExecution() only threads it
   * through to CaptureExecutionInput.workId; captureExecution() (SOR-50)
   * validates tenant/state before actually assigning it
   * (resolveTargetWorkForCorrelation(), core/tact-execution/store.ts).
   */
  workId?: string | null;
  mcpProvider?: "anthropic" | "custom" | null;
  model?: string | null;
  toolName: string;
  operation: NotionMcpCanonicalOperation;
  resource?: {
    type?: "page" | "database" | "block" | null;
    ref?: string | null;
  } | null;
  status: "succeeded" | "failed";
  /** A stable, allow-listed classification supplied by the host. Raw tool errors are not accepted. */
  errorCode?: NotionMcpSafeErrorCode | null;
  providerOccurredAt?: string | null;
  observedAt?: string;
}

function boundedString(value: string | null | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\u0000/gu, "").trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function operationFields(operation: NotionMcpCanonicalOperation): {
  actionCategory: CaptureExecutionInput["actionCategory"];
  operation: string;
} {
  switch (operation) {
    case "READ":
      return { actionCategory: "read", operation: "notion_read" };
    case "CREATE_PAGE":
      return { actionCategory: "create", operation: "notion_create_page" };
    case "UPDATE_PAGE":
      return { actionCategory: "update", operation: "notion_update_page" };
    case "DELETE_PAGE":
      return { actionCategory: "delete", operation: "notion_delete_page" };
  }
}

function safeErrorCode(value: unknown): NotionMcpSafeErrorCode {
  return typeof value === "string" && NOTION_MCP_SAFE_ERROR_CODES.includes(value as NotionMcpSafeErrorCode)
    ? value as NotionMcpSafeErrorCode
    : "notion_mcp_tool_failed";
}

function canonicalResourceType(type: "page" | "database" | "block" | null | undefined): string | undefined {
  switch (type) {
    case "page":
      return "notion_page";
    case "database":
      return "notion_database";
    case "block":
      return "notion_block";
    default:
      return undefined;
  }
}

/**
 * Converts the deliberately small, payload-free observation contract exposed
 * by a Claude/Custom MCP host into the established Canonical Execution input.
 * It deliberately has no `payload`, result, token, or error-message field.
 */
export function normalizeNotionMcpInvocationToExecution(
  observation: NotionMcpInvocationObservation
): ExecutionAdapterNormalizeResult {
  const invocationId = boundedString(observation.invocationId, 500);
  const toolName = boundedString(observation.toolName, 255);

  if (!invocationId) {
    return { ok: false, reason: "missing invocationId" };
  }

  if (!toolName) {
    return { ok: false, reason: "missing toolName" };
  }

  if (!operationFields(observation.operation)) {
    return { ok: false, reason: "unsupported Notion MCP operation" };
  }

  const mcpProvider = observation.mcpProvider === "anthropic" || observation.mcpProvider === "custom"
    ? observation.mcpProvider
    : undefined;
  const metadata = {
    ...(mcpProvider ? { mcpProvider } : {}),
    ...(boundedString(observation.model, 255) ? { model: boundedString(observation.model, 255) } : {}),
    toolName,
    ...(boundedString(observation.externalRequestId, 500)
      ? { externalRequestId: boundedString(observation.externalRequestId, 500) }
      : {}),
    ...(boundedString(observation.accountRef, 255)
      ? { accountRef: boundedString(observation.accountRef, 255) }
      : {}),
  };
  const fields = operationFields(observation.operation);

  return {
    ok: true,
    input: {
      userId: observation.userId,
      // SOR-53 Path A: 未検証のまま渡すだけ——実際のtenant/state検証は
      // captureExecution()(SOR-50、resolveTargetWorkForCorrelation())が
      // 行う。ここでは形式的なbound文字列化のみ。
      workId: boundedString(observation.workId, 255) ?? null,
      connectionId: boundedString(observation.connectionId, 255) ?? null,
      actorKind: observation.actorKind,
      actorId: boundedString(observation.principalId, 255) ?? null,
      agentId: boundedString(observation.agentId, 255) ?? null,
      provider: "mcp",
      sourceType: "sdk_callback",
      externalEventId: invocationId,
      adapterVersion: NOTION_MCP_ADAPTER_VERSION,
      sourceMetadata: metadata,
      // SOR-45: executeWithNotionMcpObservation()(observeNotionMcpExecution.ts)
      // がexecuteTool()呼び出しを直接wrapしている——TACT自身のコードが
      // 実際のprovider呼び出しを計装している既知の事実(推測ではない)。
      observationMode: "instrumented",
      actionCategory: fields.actionCategory,
      operation: fields.operation,
      resourceType: canonicalResourceType(observation.resource?.type) ?? null,
      resourceIdentifier: boundedString(observation.resource?.ref, 500) ?? null,
      targetProvider: "notion",
      status: observation.status,
      ...(observation.status === "failed"
        ? {
            errorCode: safeErrorCode(observation.errorCode),
            // The tool's raw error can include arguments, response bodies, or credentials.
            errorMessage: "Notion MCP tool execution failed",
          }
        : {}),
      providerOccurredAt: observation.providerOccurredAt ?? null,
      observedAt: observation.observedAt,
    },
  };
}
