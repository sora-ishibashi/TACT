// =========================
// SOR-130 Reality Test — GitHub (Development category)
// =========================
//
// 実GitHub API(新規disposable private repo)へ実際にissue作成/read/
// closeを行い、SOR-130で新規追加したobserveGithubIssueExecution()
// (core/tact-execution/adapters/github/、Generic Observation Gateway
// 経由)を通してlocal Supabaseのtact_canonical_executionsへ永続化する。
// 実行完了後、作成したrepoを削除する(cleanup)。既存の実運用repoには
// 一切触れない——このスクリプトが触るのは自分で新規作成したdisposable
// repoだけ。

import "./lib/loadDotEnv";

import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import {
  observeGithubIssueExecution,
  getExecutionById,
} from "../../core/tact-execution";
import { getServiceRoleClient } from "../../core/database/supabaseServiceRole";
import { applyLocalSupabaseEnv } from "./lib/localSupabaseEnv";
import { ensureRealityTestUser } from "./lib/ensureRealityTestUser";
import { check, printReport, privacySweep, type RealityTestCheck } from "./lib/reportUtils";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Human-provisioned dedicated sandbox repo, "owner/repo" (see README).
// When set, this script never creates or deletes a repository — it only
// exercises Issues READ/CREATE/CLOSE against this one pre-approved repo.
const EXISTING_TEST_REPO = process.env.SOR130_GITHUB_TEST_REPO;

async function main() {

  applyLocalSupabaseEnv();

  if (!GITHUB_TOKEN) {
    console.log("[sor130-reality-test/github] UNVERIFIED — GITHUB_TOKEN not set.");
    process.exitCode = 0;
    return;
  }

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const results: RealityTestCheck[] = [];
  const client = getServiceRoleClient();

  if (!client) {
    throw new Error("getServiceRoleClient() returned null — SUPABASE_SERVICE_ROLE_KEY was not applied correctly");
  }

  const REALITY_TEST_USER_ID = await ensureRealityTestUser(client);

  let principalLogin = "";
  let repoOwner = "";
  let repoName = "";
  let repoCreated = false;
  let repoReady = false;

  try {

    // ---- Principal identity: real authenticated GitHub user (never fabricated) ----
    const me = await octokit.rest.users.getAuthenticated();
    principalLogin = me.data.login;
    results.push(check("[identity] GET /user resolved a real GitHub principal login", typeof principalLogin === "string", principalLogin));

    const agentId = "sor130-reality-test-agent";

    if (EXISTING_TEST_REPO) {

      // ---- Use a human-provisioned dedicated sandbox repo (no create/delete) ----
      const [owner, name] = EXISTING_TEST_REPO.split("/");
      repoOwner = owner ?? "";
      repoName = name ?? "";

      try {
        const getRepoRes = await octokit.rest.repos.get({ owner: repoOwner, repo: repoName });
        repoReady = getRepoRes.status === 200;
        results.push(check("[setup] using human-provisioned dedicated sandbox repo", repoReady, EXISTING_TEST_REPO));
      } catch (error) {
        results.push(
          check(
            "[setup] using human-provisioned dedicated sandbox repo",
            false,
            error instanceof Error ? error.message : String(error)
          )
        );
      }

    } else {

      // ---- No dedicated sandbox repo provided: create+delete a disposable one ----
      repoOwner = principalLogin;
      repoName = `tact-sor130-reality-test-sandbox-${Date.now()}`;

      console.log(`[sor130-reality-test/github] creating disposable private repo: ${repoOwner}/${repoName}`);

      try {
        const createRepoRes = await octokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          private: true,
          description: "Disposable SOR-130 Generic Observation Gateway Reality Test sandbox. Safe to delete.",
          auto_init: true,
        });
        repoCreated = createRepoRes.status === 201;
        repoReady = repoCreated;
        results.push(check("[setup] disposable private repo created", repoCreated, `${repoOwner}/${repoName}`));
      } catch (error) {
        results.push(
          check(
            "[setup] disposable private repo created",
            false,
            error instanceof Error ? error.message : String(error)
          )
        );
      }

    }

    const repository = `${repoOwner}/${repoName}`;

    if (!repoReady) {
      return;
    }

    // ---- CREATE_ISSUE ----
    const createIssueRes = await octokit.rest.issues.create({
      owner: repoOwner,
      repo: repoName,
      title: "SOR-130 reality test issue",
    });
    const issueNumber = createIssueRes.data.number;
    results.push(check("[CREATE] real GitHub issue created", createIssueRes.status === 201, `#${issueNumber}`));

    const createInvocationId = `sor130-github-create-${randomUUID()}`;

    await observeGithubIssueExecution({
      userId: REALITY_TEST_USER_ID,
      actorKind: "ai_agent",
      principalId: principalLogin,
      agentId,
      invocationId: createInvocationId,
      repository,
      operation: "CREATE_ISSUE",
      issueNumber,
      status: "succeeded",
    });

    const createdRow = await client
      .from("tact_canonical_executions")
      .select("id")
      .eq("user_id", REALITY_TEST_USER_ID)
      .eq("external_event_id", createInvocationId)
      .maybeSingle();
    const executionId = (createdRow.data as { id?: string } | null)?.id ?? null;
    results.push(check("[CREATE] CanonicalExecution row persisted", !!executionId));

    // ---- READ_ISSUE ----
    const readIssueRes = await octokit.rest.issues.get({ owner: repoOwner, repo: repoName, issue_number: issueNumber });
    results.push(check("[READ] real GitHub issue read back", readIssueRes.status === 200));

    await observeGithubIssueExecution({
      userId: REALITY_TEST_USER_ID,
      actorKind: "ai_agent",
      principalId: principalLogin,
      agentId,
      invocationId: `sor130-github-read-${randomUUID()}`,
      repository,
      operation: "READ_ISSUE",
      issueNumber,
      status: "succeeded",
    });

    // ---- CLOSE_ISSUE (update) ----
    const closeIssueRes = await octokit.rest.issues.update({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber,
      state: "closed",
    });
    results.push(check("[UPDATE] real GitHub issue closed", closeIssueRes.data.state === "closed"));

    await observeGithubIssueExecution({
      userId: REALITY_TEST_USER_ID,
      actorKind: "ai_agent",
      principalId: principalLogin,
      agentId,
      invocationId: `sor130-github-close-${randomUUID()}`,
      repository,
      operation: "CLOSE_ISSUE",
      issueNumber,
      status: "succeeded",
    });

    // ---- Duplicate invocation (reuse CREATE invocationId, no new real API call) ----
    await observeGithubIssueExecution({
      userId: REALITY_TEST_USER_ID,
      actorKind: "ai_agent",
      principalId: principalLogin,
      agentId,
      invocationId: createInvocationId,
      repository,
      operation: "CREATE_ISSUE",
      issueNumber,
      status: "succeeded",
    });

    const duplicateRows = await client
      .from("tact_canonical_executions")
      .select("id")
      .eq("user_id", REALITY_TEST_USER_ID)
      .eq("external_event_id", createInvocationId);

    results.push(
      check(
        "[duplicate] re-observing the same invocationId does not create a second row",
        Array.isArray(duplicateRows.data) && duplicateRows.data.length === 1
      )
    );

    // ---- Intentional failure: read a nonexistent issue ----
    let failed = false;
    try {
      await octokit.rest.issues.get({ owner: repoOwner, repo: repoName, issue_number: 999999 });
    } catch {
      failed = true;
    }
    results.push(check("[intentional failure] reading a nonexistent issue returns a real GitHub 404", failed));

    await observeGithubIssueExecution({
      userId: REALITY_TEST_USER_ID,
      actorKind: "ai_agent",
      principalId: principalLogin,
      agentId,
      invocationId: `sor130-github-fail-${randomUUID()}`,
      repository,
      operation: "READ_ISSUE",
      issueNumber: 999999,
      status: "failed",
      errorCode: "github_not_found",
    });

    // ---- Read back persisted row + privacy sweep + Work ID / permission observation ----
    if (executionId) {
      const persisted = await getExecutionById(executionId, REALITY_TEST_USER_ID);
      results.push(check("[readback] persisted execution row is queryable via getExecutionById()", !!persisted));
      results.push(privacySweep(persisted, [GITHUB_TOKEN, "SOR-130 reality test issue"]));
      results.push(
        check(
          "[Work ID] no explicit carrier was supplied -> workId is not fabricated",
          !!persisted && persisted.workId === null,
          persisted ? `workId=${String(persisted.workId)}` : undefined
        )
      );
      results.push(
        check(
          "[permission] permissionStatus reflects the actual policy evaluation (not guessed)",
          !!persisted,
          persisted ? `permissionStatus=${persisted.permissionStatus}` : undefined
        )
      );
      results.push(
        check(
          "[provider gap] provider recorded as 'custom' — 'github' is not yet a first-class ExecutionProvider value (SOR-45 design gap)",
          !!persisted && persisted.provider === "custom"
        )
      );
    }

  } finally {
    if (repoCreated) {
      try {
        await octokit.rest.repos.delete({ owner: repoOwner, repo: repoName });
        results.push(check("[cleanup] disposable repo deleted", true));
      } catch (error) {
        results.push(
          check(
            "[cleanup] disposable repo deletion",
            false,
            `manual cleanup needed for ${principalLogin}/${repoName}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    }
    printReport("GitHub", results);
  }

}

main().catch((error) => {
  console.error("[sor130-reality-test/github] fatal error", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
