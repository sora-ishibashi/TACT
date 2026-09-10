// =========================
// TACT Conversation — Connection Resolution (Active-Only) Regression
// (LIVE-1A False Multiple Connection Resolution)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsの
// resolveIntegrationConnectionViaTactIntegrationForTesting()
// (resolveIntegrationConnectionViaTactIntegration()の実装本体、
// テスト容易性のためDI可能な形でexportされている——本番配線
// (defaultRunWorkTurnDeps)はこの同じ関数を既定deps
// (実listConnectionsForUser)で呼ぶだけの薄いラッパー経由であり、
// ここで検証するのは本番と全く同じ判定ロジックである)。
//
// READ-ONLY AUDITで確定したroot cause: 以前はDBから返る全status行の
// 件数だけでsingle/multiple/noneを判定していたため、Gmail
// provisioningを複数回行った履歴に由来するpending/failed/revoked行
// までもが「複数の候補」として誤ってmultiple判定を引き起こしていた。
// この修正により、resolution candidateはactive connectionだけに限定
// される。listConnectionsForUser()自体は実Supabaseに接続する関数の
// ため(既存tests/tact/project/projectApiAuth.test.tsと同じ既存制約:
// このHarness環境には実DBアクセス手段が無い)、ここではDeps経由で
// fakeに差し替える——実際に検証したいのは「statusでどう絞り込み、
// 何件からどのoutcomeを導くか」という判定ロジックそのものであり、
// このfakeはlistConnectionsForUser()の契約(第4引数statusが渡されたら
// その値でフィルタする)を素直に再現するだけの薄いものにとどめる。

import {
  resolveIntegrationConnectionViaTactIntegrationForTesting,
  type ResolveIntegrationConnectionViaTactIntegrationDeps,
} from "../../../core/tact-conversation/orchestration";
import type { Connection } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "gmail",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_gmail_1",
    metadata: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

// listConnectionsForUser()の実装契約(user_id/service/statusで絞り込む)
// を再現するfake。実Supabaseへは一切接続しない。
function makeFakeListConnectionsForUser(allConnections: Connection[]) {

  const calls: { userId: string; accessToken: string; service?: string; status?: string }[] = [];

  const fn: ResolveIntegrationConnectionViaTactIntegrationDeps["listConnectionsForUser"] = async (
    userId,
    accessToken,
    service,
    status
  ) => {

    calls.push({ userId, accessToken, service, status });

    return allConnections.filter(
      (c) =>
        c.userId === userId &&
        (!service || c.service === service) &&
        (!status || c.status === status)
    );

  };

  return { fn, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A. active 1 + revoked 2 -> single ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-active", status: "active" }),
      makeConnection({ id: "conn-revoked-1", status: "revoked" }),
      makeConnection({ id: "conn-revoked-2", status: "revoked" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[A] active 1 + revoked 2 -> single(active行だけを候補とする)",
        outcome.status === "single" && outcome.connectionId === "conn-active"
      )
    );
  }

  // ---- B. active 1 + pending 1 -> single ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-active", status: "active" }),
      makeConnection({ id: "conn-pending", status: "pending" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[B] active 1 + pending 1 -> single",
        outcome.status === "single" && outcome.connectionId === "conn-active"
      )
    );
  }

  // ---- C. active 1 + revoked 1 + pending 1 -> single ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-active", status: "active" }),
      makeConnection({ id: "conn-revoked", status: "revoked" }),
      makeConnection({ id: "conn-pending", status: "pending" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[C] active 1 + revoked 1 + pending 1 -> single(Gmail LIVE-1Aで実際に再現していた構成)",
        outcome.status === "single" && outcome.connectionId === "conn-active"
      )
    );
  }

  // ---- D. active 2 -> multiple(countはactive件数のみを反映する) ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-active-1", status: "active" }),
      makeConnection({ id: "conn-active-2", status: "active" }),
      makeConnection({ id: "conn-failed", status: "failed" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[D] active 2(+failed 1) -> multiple、countはactive件数(2)のみを反映する(failedを混ぜない)",
        outcome.status === "multiple" && outcome.count === 2
      )
    );
  }

  // ---- E. active 0 + pending/revoked/failed -> none ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-pending", status: "pending" }),
      makeConnection({ id: "conn-revoked", status: "revoked" }),
      makeConnection({ id: "conn-failed", status: "failed" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[E] active 0(pending/revoked/failedのみ) -> none(unavailableではなく、Approval/read両経路が共有する既存none語彙のまま)",
        outcome.status === "none"
      )
    );
  }

  // ---- F. active 0 + 行自体が0件 -> none ----
  {
    const { fn } = makeFakeListConnectionsForUser([]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[F] Connection行が1件も無い -> none",
        outcome.status === "none"
      )
    );
  }

  // ---- 呼び出しパラメータの直接確認: statusは必ず"active"を渡し、
  // userId/serviceはcallerの値をそのまま使う(推測・書き換えをしない) ----
  {
    const { fn, calls } = makeFakeListConnectionsForUser([makeConnection()]);

    await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token-xyz", service: "gmail" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[呼び出し確認] listConnectionsForUser()はstatus=\"active\"付きで正確に1回呼ばれる、userId/accessToken/serviceはcaller値のまま",
        calls.length === 1 &&
          calls[0].userId === OWNER_USER_ID &&
          calls[0].accessToken === "token-xyz" &&
          calls[0].service === "gmail" &&
          calls[0].status === "active"
      )
    );
  }

  // ---- Slackも全く同じ関数(service分岐なし)を通ることを確認 ----
  {
    const { fn } = makeFakeListConnectionsForUser([
      makeConnection({ id: "conn-slack-active", service: "slack", status: "active" }),
      makeConnection({ id: "conn-slack-old", service: "slack", status: "revoked" }),
    ]);

    const outcome = await resolveIntegrationConnectionViaTactIntegrationForTesting(
      { userId: OWNER_USER_ID, accessToken: "token", service: "slack" },
      { listConnectionsForUser: fn }
    );

    results.push(
      check(
        "[Slack回帰無し] Slackもactiveのみを候補にする同じロジックを通り、revokedな旧Connectionに惑わされない",
        outcome.status === "single" && outcome.connectionId === "conn-slack-active"
      )
    );
  }

  return summarize("conversation/connectionResolutionActiveOnly", results);

}
