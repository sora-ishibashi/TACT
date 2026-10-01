// =========================
// TACT Canonical Execution — GitHub Issue Adapter (SOR-130 Reality Test)
// =========================
//
// SOR-130: Generic Observation GatewayをNotion/Slack以外のカテゴリ
// (Development)でも実際に通せるかを検証するための、最小限の新規
// provider adapter。core/tact-execution/adapters/notion/
// normalizeNotionMcpExecution.tsと同じ形(一つのoperation enumが
// READ/CREATE/UPDATE系へ写像する、payload本文を持たない観測contract)
// をそのまま踏襲する。
//
// 設計上のgap(SOR-45へ差し戻す事実): core/tact-execution/types.tsの
// ExecutionProviderには"github"という値が存在せず、対応するDB CHECK
// 制約(supabase/migrations/20261020000000_create_tact_canonical_
// executions.sql)にも含まれていない。ここではmigrationを増やさず
// (SOR-130の制約)、既存の"custom"値をprovider/targetProviderとして
// 使い、実体の識別はadapterVersion("github-issue-v1")・
// resourceType("github_issue")・operation文字列("github_*")に委ねる。
// "github"を正式なExecutionProvider値として追加するかどうかは、
// Canonical Execution契約そのものの拡張(SOR-45のスコープ)として
// 別途判断する。

import type { CaptureExecutionInput, ExecutionActorKind } from "../../types";
import type { ExecutionAdapterNormalizeResult } from "../types";

export const GITHUB_ISSUE_ADAPTER_VERSION = "github-issue-v1";

export type GithubIssueCanonicalOperation = "READ_ISSUE" | "CREATE_ISSUE" | "CLOSE_ISSUE";

export type GithubIssueSafeErrorCode =
  | "github_api_call_failed"
  | "github_rate_limited"
  | "github_not_found"
  | "github_permission_denied";

const GITHUB_ISSUE_SAFE_ERROR_CODES: readonly GithubIssueSafeErrorCode[] = [
  "github_api_call_failed",
  "github_rate_limited",
  "github_not_found",
  "github_permission_denied",
];

export interface GithubIssueInvocationObservation {
  userId: string;
  actorKind: ExecutionActorKind;
  /** The authenticated GitHub principal (login), when known. Never fabricated. */
  principalId?: string | null;
  agentId?: string | null;
  connectionId?: string | null;
  /**
   * SOR-130絶対条件(Work IDについて): legitimateなexplicit carrierが
   * 無い限りnull(UNASSIGNED/STRUCTURALとして正しく扱う)。呼び出し元が
   * 推測で埋めてはならない。
   */
  workId?: string | null;
  /** Idempotency key for captureExecution(). */
  invocationId: string;
  /** "owner/repo" — non-secret, does not include issue title/body. */
  repository: string;
  operation: GithubIssueCanonicalOperation;
  issueNumber?: number | null;
  status: "succeeded" | "failed";
  errorCode?: GithubIssueSafeErrorCode | null;
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

function operationFields(operation: GithubIssueCanonicalOperation): {
  actionCategory: CaptureExecutionInput["actionCategory"];
  operation: string;
} {
  switch (operation) {
    case "READ_ISSUE":
      return { actionCategory: "read", operation: "github_read_issue" };
    case "CREATE_ISSUE":
      return { actionCategory: "create", operation: "github_create_issue" };
    case "CLOSE_ISSUE":
      return { actionCategory: "update", operation: "github_close_issue" };
  }
}

function safeErrorCode(value: unknown): GithubIssueSafeErrorCode {
  return typeof value === "string" && GITHUB_ISSUE_SAFE_ERROR_CODES.includes(value as GithubIssueSafeErrorCode)
    ? value as GithubIssueSafeErrorCode
    : "github_api_call_failed";
}

/**
 * Converts a payload-free GitHub Issues observation (no issue title/body,
 * no raw API response) into the established Canonical Execution input.
 */
export function normalizeGithubIssueInvocationToExecution(
  observation: GithubIssueInvocationObservation
): ExecutionAdapterNormalizeResult {
  const invocationId = boundedString(observation.invocationId, 500);
  const repository = boundedString(observation.repository, 255);

  if (!invocationId) {
    return { ok: false, reason: "missing invocationId" };
  }

  if (!repository) {
    return { ok: false, reason: "missing repository" };
  }

  const fields = operationFields(observation.operation);

  const resourceIdentifier =
    typeof observation.issueNumber === "number"
      ? `${repository}#${observation.issueNumber}`
      : repository;

  return {
    ok: true,
    input: {
      userId: observation.userId,
      workId: boundedString(observation.workId, 255) ?? null,
      connectionId: boundedString(observation.connectionId, 255) ?? null,
      actorKind: observation.actorKind,
      actorId: boundedString(observation.principalId, 255) ?? null,
      agentId: boundedString(observation.agentId, 255) ?? null,
      // SOR-45設計gap(このfile冒頭コメント参照): "github"はまだ
      // ExecutionProviderの正式値ではないため、既存の"custom"を使う。
      provider: "custom",
      targetProvider: "custom",
      sourceType: "sdk_callback",
      externalEventId: invocationId,
      adapterVersion: GITHUB_ISSUE_ADAPTER_VERSION,
      sourceMetadata: { repository },
      // このAdapterの呼び出し元(observeGithubIssueExecution.ts)は
      // 実際のGitHub API呼び出しを直接wrapする——TACT自身のコードが
      // provider呼び出しを計装している既知の事実(推測ではない)。
      observationMode: "instrumented",
      actionCategory: fields.actionCategory,
      operation: fields.operation,
      resourceType: "github_issue",
      resourceIdentifier,
      status: observation.status,
      ...(observation.status === "failed"
        ? {
            errorCode: safeErrorCode(observation.errorCode),
            // Raw GitHub API error bodies can include repository/user detail beyond what's needed here.
            errorMessage: "GitHub API call failed",
          }
        : {}),
      providerOccurredAt: observation.providerOccurredAt ?? null,
      observedAt: observation.observedAt,
    },
  };
}
