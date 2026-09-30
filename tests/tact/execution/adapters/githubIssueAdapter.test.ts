// =========================
// TACT Canonical Execution — GitHub Issue Adapter Regression (SOR-130)
// =========================
//
// 対象: core/tact-execution/adapters/github/normalizeGithubIssueExecution.ts
// のnormalizeGithubIssueInvocationToExecution()(純粋関数、DBアクセス
// なし)。SOR-130のReality Testが実際に使うadapterの、決定論的な
// mock-based regression。

import { normalizeGithubIssueInvocationToExecution } from "../../../../core/tact-execution/adapters/github/normalizeGithubIssueExecution";

import { check, summarize, type CheckResult } from "../../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: READ_ISSUE -> read/github_read_issue、provider='custom'(SOR-45 gap) ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "ai_agent",
      principalId: "octocat",
      agentId: "sor130-reality-test-agent",
      invocationId: "inv-read-1",
      repository: "octo-org/octo-repo",
      operation: "READ_ISSUE",
      issueNumber: 42,
      status: "succeeded",
    });

    results.push(check("[Test1] READ_ISSUEはok=trueを返す", result.ok === true));

    if (result.ok) {
      results.push(
        check(
          "[Test1] provider='custom'('github'値が未存在なためSOR-45 gapとして記録)、actionCategory/operation/resourceが正規化される",
          result.input.provider === "custom" &&
            result.input.actionCategory === "read" &&
            result.input.operation === "github_read_issue" &&
            result.input.resourceType === "github_issue" &&
            result.input.resourceIdentifier === "octo-org/octo-repo#42"
        )
      );

      results.push(
        check(
          "[Test1] agent/principal attributionが両方伝播する(actorKind='ai_agent', actorId=principalId, agentId)",
          result.input.actorKind === "ai_agent" &&
            result.input.actorId === "octocat" &&
            result.input.agentId === "sor130-reality-test-agent"
        )
      );

      results.push(
        check(
          "[Test1] observationMode='instrumented'(TACT自身がGitHub API呼び出しを直接wrapする)",
          result.input.observationMode === "instrumented"
        )
      );

      results.push(
        check(
          "[Test1] workIdはlegitimateなcarrierが無ければnull(fake claimを作らない)",
          result.input.workId === null
        )
      );
    }
  }

  // ---- Test2: CREATE_ISSUE -> create/github_create_issue ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-create-1",
      repository: "octo-org/octo-repo",
      operation: "CREATE_ISSUE",
      issueNumber: 43,
      status: "succeeded",
    });

    results.push(
      check(
        "[Test2] CREATE_ISSUEはactionCategory='create'、operation='github_create_issue'に写像される",
        result.ok === true && result.input.actionCategory === "create" && result.input.operation === "github_create_issue"
      )
    );
  }

  // ---- Test3: CLOSE_ISSUE -> update/github_close_issue ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-close-1",
      repository: "octo-org/octo-repo",
      operation: "CLOSE_ISSUE",
      issueNumber: 43,
      status: "succeeded",
    });

    results.push(
      check(
        "[Test3] CLOSE_ISSUEはactionCategory='update'、operation='github_close_issue'に写像される",
        result.ok === true && result.input.actionCategory === "update" && result.input.operation === "github_close_issue"
      )
    );
  }

  // ---- Test4: 失敗時はsafe error codeへ丸められ、生エラーは保存しない ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-fail-1",
      repository: "octo-org/octo-repo",
      operation: "READ_ISSUE",
      issueNumber: 999999,
      status: "failed",
      errorCode: "github_not_found",
    });

    results.push(
      check(
        "[Test4] 失敗時はallow-listされたerrorCodeのみ保持し、errorMessageは固定文言(生エラー本文を保存しない)",
        result.ok === true &&
          result.input.status === "failed" &&
          result.input.errorCode === "github_not_found" &&
          result.input.errorMessage === "GitHub API call failed"
      )
    );
  }

  // ---- Test5: 未知のerrorCodeはgithub_api_call_failedへ丸められる(捏造しない) ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-fail-2",
      repository: "octo-org/octo-repo",
      operation: "READ_ISSUE",
      status: "failed",
      errorCode: "totally_unknown_code" as never,
    });

    results.push(
      check(
        "[Test5] allow-list外のerrorCodeはgithub_api_call_failedへ丸められる",
        result.ok === true && result.input.errorCode === "github_api_call_failed"
      )
    );
  }

  // ---- Test6: invocationId/repository欠落はok=false ----
  {
    const missingInvocation = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "",
      repository: "octo-org/octo-repo",
      operation: "READ_ISSUE",
      status: "succeeded",
    });

    const missingRepository = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-1",
      repository: "",
      operation: "READ_ISSUE",
      status: "succeeded",
    });

    results.push(
      check(
        "[Test6] invocationId欠落、repository欠落はどちらもok=falseを返す(idempotency/識別性が成立しない)",
        missingInvocation.ok === false && missingRepository.ok === false
      )
    );
  }

  // ---- Test7: repositoryのみ(issueNumber無し)ではresourceIdentifierがrepository自体になる ----
  {
    const result = normalizeGithubIssueInvocationToExecution({
      userId: "user-1",
      actorKind: "service",
      invocationId: "inv-repo-only",
      repository: "octo-org/octo-repo",
      operation: "CREATE_ISSUE",
      status: "succeeded",
    });

    results.push(
      check(
        "[Test7] issueNumber省略時はresourceIdentifierがrepository文字列そのものになる",
        result.ok === true && result.input.resourceIdentifier === "octo-org/octo-repo"
      )
    );
  }

  return summarize("SOR-130 — GitHub Issue Adapter", results);

}
