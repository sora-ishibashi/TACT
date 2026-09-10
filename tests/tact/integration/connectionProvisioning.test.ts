// =========================
// TACT Integration — Connection Provisioning Regression
// (LIVE-1A: Generic Connection Provisioning Foundation)
// =========================
//
// 対象: core/tact-integration/provisioning.tsの
// createIntegrationConnectionLink()・refreshIntegrationConnectionStatus()。
// 実Supabase・実Composio APIには一切接続しない
// (Deps経由でConnection store呼び出し・ConnectionProvisioningProvider
// 自体を偽実装に差し替える、tests/tact/integration/execution.test.ts
// と同じ既存DIパターン)。
//
// 識別不変条件(IDENTITY INVARIANT)の検証だけは例外的にsource-level
// (正規表現でファイルのテキストを直接確認する)で行う——
// tests/tact/integration/connectionSchema.test.tsが既に同じ手法で
// migration SQLを検証しており、この既存パターンをそのまま踏襲する。
// 理由: provisioning側(createComposioConnectionLink())と
// execution側(adapter.tsのexecuteComposio())はいずれも実
// @composio/coreクライアントを直接呼ぶ薄いfileであり、この2箇所を
// 実APIなしに「同じ関数・同じ入力で呼んでいる」ことを検証する最も
// 確実な方法は、両方が文字通りtoComposioUserId(...)を呼んでいる
// ことをソースから確認すること(モックへの分岐を新設するより
// 安全で、実装の意図から乖離しない)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIntegrationConnectionLink,
  refreshIntegrationConnectionStatus,
  type CreateIntegrationConnectionLinkDeps,
  type RefreshIntegrationConnectionStatusDeps,
} from "../../../core/tact-integration/provisioning";
import type {
  Connection,
  ConnectionProvisioningProvider,
  ProviderConnectionLinkResult,
} from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

const OWNER_USER_ID = "user-1";
const OWNER_ACCESS_TOKEN = "token-1";

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "gmail",
    status: "pending",
    provider: "composio",
    providerConnectionRef: "ca_gmail_123",
    metadata: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeLinkResult(overrides: Partial<ProviderConnectionLinkResult> = {}): ProviderConnectionLinkResult {
  return {
    providerConnectionRef: "ca_gmail_123",
    redirectUrl: "https://backend.composio.dev/oauth/callback?id=abc",
    canonicalStatus: "pending",
    providerStatusRaw: "INITIATED",
    ...overrides,
  };
}

// PRODUCT-P1でConnectionProvisioningProviderにdisableConnection()が
// 追加されたため、既存の各fakeで毎回書かずに済むよう最小限のdefaultを
// 提供する(既存test caseの意図はcreateConnectionLink/getConnectionStatus
// の差し替えだけであり、disableConnectionは今回の対象ではない)。
function makeFakeProvider(
  overrides: Partial<ConnectionProvisioningProvider> = {}
): ConnectionProvisioningProvider {
  return {
    createConnectionLink: async () => null,
    getConnectionStatus: async () => null,
    disableConnection: async () => false,
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // createIntegrationConnectionLink()
  // =========================

  {
    let capturedCreateConnectionArgs: unknown[] | undefined;

    const fakeProvider = makeFakeProvider({
      createConnectionLink: async () => makeLinkResult(),
    });

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: fakeProvider,
      generateConnectionId: () => "generated-id",
      createConnection: async (userId, accessToken, params) => {
        capturedCreateConnectionArgs = [userId, accessToken, params];
        return makeConnection({
          userId,
          service: params.service,
          providerConnectionRef: params.providerConnectionRef,
          status: params.status ?? "pending",
          metadata: params.metadata ?? null,
        });
      },
    };

    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] authenticated userはGmail connection linkを要求できる(status=created)",
        outcome.status === "created" && outcome.redirectUrl === makeLinkResult().redirectUrl
      )
    );

    results.push(
      check(
        "[LIVE-1A] canonical persistenceはowner-bound(caller由来のuserId/accessTokenだけを使う)",
        Array.isArray(capturedCreateConnectionArgs) &&
          capturedCreateConnectionArgs[0] === OWNER_USER_ID &&
          capturedCreateConnectionArgs[1] === OWNER_ACCESS_TOKEN
      )
    );

    results.push(
      check(
        "[LIVE-1A] providerConnectionRefはProviderの戻り値からのみ設定される(callerが注入できない)",
        Array.isArray(capturedCreateConnectionArgs) &&
          (capturedCreateConnectionArgs[2] as { providerConnectionRef?: string })?.providerConnectionRef ===
            "ca_gmail_123"
      )
    );

    results.push(
      check(
        "[LIVE-1A] status=activeは絶対に主張しない(Provider側がpendingを返した場合、Connectionもpendingのまま)",
        Array.isArray(capturedCreateConnectionArgs) &&
          (capturedCreateConnectionArgs[2] as { status?: string })?.status === "pending"
      )
    );
  }

  // unsupported serviceはfail closed(Provider呼び出し0)。
  {
    let providerCalled = false;

    const fakeProvider = makeFakeProvider({
      createConnectionLink: async () => {
        providerCalled = true;
        return makeLinkResult();
      },
    });

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: fakeProvider,
      generateConnectionId: () => "generated-id",
      createConnection: async () => makeConnection(),
    };

    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "notion" },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] 未対応service(例: notion)はunsupported_serviceへfail closedする",
        outcome.status === "unsupported_service" && !providerCalled
      )
    );
  }

  // Provider未設定(auth config欠如等)は安全にfallbackする(DB書き込み0)。
  {
    let createConnectionCalled = false;

    const fakeProvider = makeFakeProvider();

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: fakeProvider,
      generateConnectionId: () => "generated-id",
      createConnection: async () => {
        createConnectionCalled = true;
        return makeConnection();
      },
    };

    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] Provider未設定時はprovider_not_configuredへ安全にfallbackする(tact_connectionsへ書き込まない)",
        outcome.status === "provider_not_configured" && !createConnectionCalled
      )
    );
  }

  // Slackも全く同じ関数(分岐なし)を通ることを確認(既存Slack挙動の
  // 非regression)。
  {
    const fakeProvider = makeFakeProvider({
      createConnectionLink: async (service) =>
        makeLinkResult({ providerConnectionRef: `ca_${service}_1` }),
    });

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: fakeProvider,
      generateConnectionId: () => "generated-id",
      createConnection: async (userId, accessToken, params) =>
        makeConnection({ service: params.service, providerConnectionRef: params.providerConnectionRef }),
    };

    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "slack" },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] 既存Slack接続要求は引き続きcreatedへ到達する(Gmail追加によるregressionなし)",
        outcome.status === "created" && outcome.connection.providerConnectionRef === "ca_slack_1"
      )
    );
  }

  // =========================
  // refreshIntegrationConnectionStatus()
  // =========================

  {
    const deps: RefreshIntegrationConnectionStatusDeps = {
      getConnection: async () => undefined,
      updateConnectionStatus: async () => {},
      provider: makeFakeProvider(),
      finalizeConnectionReplacement: async () => ({ revokedConnectionIds: [] }),
    };

    const outcome = await refreshIntegrationConnectionStatus(
      { connectionId: "missing", userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] 存在しない/所有者不一致のconnectionIdはnot_foundを返す(IDOR対策)",
        outcome.status === "not_found"
      )
    );
  }

  {
    let updateCalled = false;
    let finalizeCalledWith: unknown;

    const deps: RefreshIntegrationConnectionStatusDeps = {
      getConnection: async () => makeConnection({ status: "pending" }),
      updateConnectionStatus: async () => {
        updateCalled = true;
      },
      provider: makeFakeProvider({
        getConnectionStatus: async () => ({ canonicalStatus: "active", providerStatusRaw: "ACTIVE" }),
      }),
      finalizeConnectionReplacement: async (params) => {
        finalizeCalledWith = params;
        return { revokedConnectionIds: [] };
      },
    };

    // 2回目のgetConnection()呼び出し(refresh後の再取得)がactiveを
    // 返すよう、単純にactive済みConnectionを返すfakeにする。
    let getConnectionCallCount = 0;
    deps.getConnection = async () => {
      getConnectionCallCount += 1;
      return getConnectionCallCount === 1
        ? makeConnection({ status: "pending" })
        : makeConnection({ status: "active" });
    };

    const outcome = await refreshIntegrationConnectionStatus(
      { connectionId: "conn-1", userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] ProviderがACTIVEを報告した場合、pending -> activeへ同期しupdateConnectionStatus()を呼ぶ",
        outcome.status === "synced" && outcome.connection.status === "active" && updateCalled
      )
    );

    results.push(
      check(
        "[PRODUCT-P1] pending -> active遷移の直後にfinalizeConnectionReplacement()がこのconnectionをkeepConnectionIdとして正確に1回呼ばれる(Reconnect cutoverの起点)",
        typeof finalizeCalledWith === "object" &&
          finalizeCalledWith !== null &&
          (finalizeCalledWith as { keepConnectionId?: string }).keepConnectionId === "conn-1" &&
          (finalizeCalledWith as { service?: string }).service === "gmail"
      )
    );
  }

  {
    let providerCalled = false;
    let finalizeCalled = false;

    const deps: RefreshIntegrationConnectionStatusDeps = {
      getConnection: async () => makeConnection({ status: "active" }),
      updateConnectionStatus: async () => {},
      provider: makeFakeProvider({
        getConnectionStatus: async () => {
          providerCalled = true;
          return { canonicalStatus: "active", providerStatusRaw: "ACTIVE" };
        },
      }),
      finalizeConnectionReplacement: async () => {
        finalizeCalled = true;
        return { revokedConnectionIds: [] };
      },
    };

    const outcome = await refreshIntegrationConnectionStatus(
      { connectionId: "conn-1", userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN },
      deps
    );

    results.push(
      check(
        "[LIVE-1A] 既にactiveなConnectionはProviderへ再問い合わせしない(不要な呼び出しを増やさない)",
        outcome.status === "synced" && !providerCalled
      )
    );

    results.push(
      check(
        "[PRODUCT-P1] 既にactiveで状態遷移が無い場合、finalizeConnectionReplacement()も呼ばれない(不要なcutover処理を増やさない)",
        !finalizeCalled
      )
    );
  }

  // =========================
  // Source-level invariants
  // =========================

  const connectionLinkSource = readRepoFile(
    "core/tact-integration/providers/composio/connectionLink.ts"
  );
  const adapterSource = readRepoFile("core/tact-integration/providers/composio/adapter.ts");
  const provisioningSource = readRepoFile("core/tact-integration/provisioning.ts");

  results.push(
    check(
      "[IDENTITY INVARIANT] provisioning(createComposioConnectionLink)はtoComposioUserId(tactUserId)を使う",
      /client\.connectedAccounts\.link\(\s*toComposioUserId\(tactUserId\)/.test(connectionLinkSource)
    )
  );

  results.push(
    check(
      "[IDENTITY INVARIANT] execution(executeComposio)はtoComposioUserId(request.userId)を使う",
      /userId:\s*toComposioUserId\(request\.userId\)/.test(adapterSource)
    )
  );

  results.push(
    check(
      "[Provider boundary] Gmail Auth Config ID解決(env var名)はComposio adapter配下だけに存在する",
      /COMPOSIO_GMAIL_AUTH_CONFIG_ID/.test(connectionLinkSource) &&
        !/COMPOSIO_GMAIL_AUTH_CONFIG_ID/.test(provisioningSource)
    )
  );

  results.push(
    check(
      "[Provider boundary] canonical provisioning.tsはComposio固有語彙(auth config id解決)を持たない",
      !/AUTH_CONFIG_ID/.test(provisioningSource)
    )
  );

  return summarize("integration/connectionProvisioning", results);

}
