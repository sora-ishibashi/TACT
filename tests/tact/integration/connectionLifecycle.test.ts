// =========================
// TACT Integration — Connection Lifecycle Regression
// (PRODUCT-P1: Connection UX — Reconnect / Disconnect / OAuth Return)
// =========================
//
// 対象: core/tact-integration/provisioning.tsの
// finalizeConnectionReplacement() / disconnectIntegrationConnection() /
// createIntegrationConnectionLink()のcallbackUrl/connectionId事前生成
// 機能。実Supabase・実Composio APIには一切接続しない(Deps経由で
// 差し替える、既存tests/tact/integration/connectionProvisioning.test.ts
// と同じDIパターン)。

import {
  createIntegrationConnectionLink,
  disconnectIntegrationConnection,
  finalizeConnectionReplacement,
  refreshIntegrationConnectionStatus,
  type CreateIntegrationConnectionLinkDeps,
  type DisconnectIntegrationConnectionDeps,
  type FinalizeConnectionReplacementDeps,
  type RefreshIntegrationConnectionStatusDeps,
} from "../../../core/tact-integration/provisioning";
import type {
  Connection,
  ConnectionProvisioningProvider,
  ProviderConnectionLinkResult,
} from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";
const OWNER_ACCESS_TOKEN = "token-1";

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

function makeFakeProvider(
  overrides: Partial<ConnectionProvisioningProvider> = {}
): ConnectionProvisioningProvider {
  return {
    createConnectionLink: async () => null,
    getConnectionStatus: async () => null,
    disableConnection: async () => true,
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // createIntegrationConnectionLink(): callbackUrl / connectionId事前生成
  // (OAuth Return Flowの土台。ブラウザからproviderConnectionRefを送ら
  // ない・connectionIdは常にTACT server側で生成される、絶対条件)
  // =========================

  {
    let capturedCallbackUrl: string | undefined;
    let capturedCreateConnectionId: string | undefined;

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: makeFakeProvider({
        createConnectionLink: async (_service, _tactUserId, callbackUrl) => {
          capturedCallbackUrl = callbackUrl;
          return {
            providerConnectionRef: "ca_gmail_new",
            redirectUrl: "https://backend.composio.dev/oauth/abc",
            canonicalStatus: "pending",
            providerStatusRaw: "INITIATED",
          } satisfies ProviderConnectionLinkResult;
        },
      }),
      generateConnectionId: () => "generated-connection-id",
      createConnection: async (userId, accessToken, params) => {
        capturedCreateConnectionId = params.id;
        return makeConnection({ id: params.id ?? "fallback-id", status: "pending" });
      },
    };

    await createIntegrationConnectionLink(
      {
        userId: OWNER_USER_ID,
        accessToken: OWNER_ACCESS_TOKEN,
        service: "gmail",
        callbackUrl: "https://tact.example.com/?section=settings",
      },
      deps
    );

    results.push(
      check(
        "[PRODUCT-P1] callbackUrl指定時、providerへ渡すURLに事前生成したconnectionIdがquery paramとして埋め込まれる",
        capturedCallbackUrl === "https://tact.example.com/?section=settings&connectionId=generated-connection-id"
      )
    );

    results.push(
      check(
        "[PRODUCT-P1] createConnection()には同じ事前生成idがそのまま渡る(providerが知らないTACT側生成値、callerが注入する値ではない)",
        capturedCreateConnectionId === "generated-connection-id"
      )
    );
  }

  {
    // callbackUrl省略時は既存(LIVE-1A)挙動のまま——idは事前生成しない
    // (既存呼び出し元・既存testへの後方互換)。
    let capturedCallbackUrl: string | undefined = "not-called";
    let capturedCreateConnectionId: string | undefined = "not-called";

    const deps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: makeFakeProvider({
        createConnectionLink: async (_service, _tactUserId, callbackUrl) => {
          capturedCallbackUrl = callbackUrl;
          return {
            providerConnectionRef: "ca_gmail_new",
            redirectUrl: "https://backend.composio.dev/oauth/abc",
            canonicalStatus: "pending",
            providerStatusRaw: "INITIATED",
          } satisfies ProviderConnectionLinkResult;
        },
      }),
      generateConnectionId: () => "generated-connection-id",
      createConnection: async (userId, accessToken, params) => {
        capturedCreateConnectionId = params.id;
        return makeConnection({ status: "pending" });
      },
    };

    await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[PRODUCT-P1] callbackUrl省略時、providerへundefinedを渡す(既存LIVE-1A挙動を変更しない)",
        capturedCallbackUrl === undefined
      )
    );

    results.push(
      check(
        "[PRODUCT-P1] callbackUrl省略時、idも事前生成しない(DB側のdefault gen_random_uuid()に任せる)",
        capturedCreateConnectionId === undefined
      )
    );
  }

  // =========================
  // finalizeConnectionReplacement()
  // =========================

  {
    const revokeCalls: { connectionId: string; status: string }[] = [];

    const deps: FinalizeConnectionReplacementDeps = {
      listConnectionsForUser: async () => [
        makeConnection({ id: "conn-old", status: "active" }),
        makeConnection({ id: "conn-new", status: "active" }),
      ],
      updateConnectionStatus: async (connectionId, _userId, _accessToken, status) => {
        revokeCalls.push({ connectionId, status });
      },
    };

    const outcome = await finalizeConnectionReplacement(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail", keepConnectionId: "conn-new" },
      deps
    );

    results.push(
      check(
        "[I] reconnect cutover: old active(conn-old)だけがrevokedになり、new active(conn-new)は一切触られない",
        outcome.revokedConnectionIds.length === 1 &&
          outcome.revokedConnectionIds[0] === "conn-old" &&
          revokeCalls.length === 1 &&
          revokeCalls[0].connectionId === "conn-old" &&
          revokeCalls[0].status === "revoked"
      )
    );
  }

  {
    // 初回接続(既存activeが無い)でも安全に呼べる(副作用ゼロ)。
    let updateCalled = false;

    const deps: FinalizeConnectionReplacementDeps = {
      listConnectionsForUser: async () => [makeConnection({ id: "conn-new", status: "active" })],
      updateConnectionStatus: async () => {
        updateCalled = true;
      },
    };

    const outcome = await finalizeConnectionReplacement(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail", keepConnectionId: "conn-new" },
      deps
    );

    results.push(
      check(
        "[PRODUCT-P1] 初回接続(他にactiveが無い)ではfinalizeが何もrevokeしない(副作用ゼロ)",
        outcome.revokedConnectionIds.length === 0 && !updateCalled
      )
    );
  }

  // =========================
  // refreshIntegrationConnectionStatus(): reconnect failure時、old
  // activeは一切触られない([J])
  // =========================

  {
    let finalizeCalled = false;
    let oldConnectionTouched = false;

    const deps: RefreshIntegrationConnectionStatusDeps = {
      getConnection: async () => makeConnection({ id: "conn-new", status: "pending" }),
      updateConnectionStatus: async (connectionId) => {
        if (connectionId === "conn-old") {
          oldConnectionTouched = true;
        }
      },
      provider: makeFakeProvider({
        // Providerが依然としてpending(OAuth未完了/失敗)を報告する
        // ケース。
        getConnectionStatus: async () => ({ canonicalStatus: "failed", providerStatusRaw: "FAILED" }),
      }),
      finalizeConnectionReplacement: async () => {
        finalizeCalled = true;
        return { revokedConnectionIds: [] };
      },
    };

    await refreshIntegrationConnectionStatus(
      { connectionId: "conn-new", userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN },
      deps
    );

    results.push(
      check(
        "[J] reconnect failure: 新しいConnectionがactiveにならなかった場合、finalizeConnectionReplacement()は呼ばれず、old activeは一切touchされない",
        !finalizeCalled && !oldConnectionTouched
      )
    );
  }

  // =========================
  // disconnectIntegrationConnection()
  // =========================

  {
    const revokedIds: string[] = [];
    let providerDisableCalledWith: string | undefined;

    const deps: DisconnectIntegrationConnectionDeps = {
      provider: makeFakeProvider({
        disableConnection: async (ref) => {
          providerDisableCalledWith = ref;
          return true;
        },
      }),
      listConnectionsForUser: async () => [makeConnection({ id: "conn-1", status: "active", providerConnectionRef: "ca_1" })],
      updateConnectionStatus: async (connectionId, _userId, _accessToken, status) => {
        if (status === "revoked") {
          revokedIds.push(connectionId);
        }
      },
    };

    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[K] disconnect: activeなConnectionのcanonical statusがrevokedになり、Provider側disableもbest-effortで呼ばれる",
        outcome.status === "disconnected" &&
          outcome.revokedConnectionIds.length === 1 &&
          revokedIds[0] === "conn-1" &&
          providerDisableCalledWith === "ca_1"
      )
    );
  }

  {
    // Provider側disableが失敗/例外でも、TACT canonical revokeは必ず
    // 実行される(設計理由: TACT owns canonical connection state、
    // fail-open on provider call)。
    const revokedIds: string[] = [];

    const deps: DisconnectIntegrationConnectionDeps = {
      provider: makeFakeProvider({
        disableConnection: async () => {
          throw new Error("simulated Composio outage");
        },
      }),
      listConnectionsForUser: async () => [makeConnection({ id: "conn-1", status: "active" })],
      updateConnectionStatus: async (connectionId, _userId, _accessToken, status) => {
        if (status === "revoked") {
          revokedIds.push(connectionId);
        }
      },
    };

    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[K] disconnect設計理由の直接検証: Provider側disableが例外を投げても、canonical revokeは成功として完了する(fail-open on provider, fail-closed never on canonical status)",
        outcome.status === "disconnected" && revokedIds.length === 1
      )
    );
  }

  {
    // 冪等性: 既にactiveが無い場合も例外を投げず、not_connectedとして
    // 安全に完了する(二重クリック対策)。
    const deps: DisconnectIntegrationConnectionDeps = {
      provider: makeFakeProvider(),
      listConnectionsForUser: async () => [],
      updateConnectionStatus: async () => {},
    };

    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[PRODUCT-P1] 既にactiveが無い場合、disconnectは冪等にnot_connectedを返す(二重クリックで例外にしない)",
        outcome.status === "not_connected"
      )
    );
  }

  {
    // error state(誤って複数active)の自己修復: disconnectは全active
    // をrevokeする。
    const revokedIds: string[] = [];

    const deps: DisconnectIntegrationConnectionDeps = {
      provider: makeFakeProvider(),
      listConnectionsForUser: async () => [
        makeConnection({ id: "conn-a", status: "active" }),
        makeConnection({ id: "conn-b", status: "active" }),
      ],
      updateConnectionStatus: async (connectionId) => {
        revokedIds.push(connectionId);
      },
    };

    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "gmail" },
      deps
    );

    results.push(
      check(
        "[絶対条件6 Active Uniqueness] error state(複数active)もdisconnectで全て解除でき、自己修復できる",
        outcome.status === "disconnected" &&
          outcome.revokedConnectionIds.length === 2 &&
          revokedIds.includes("conn-a") &&
          revokedIds.includes("conn-b")
      )
    );
  }

  {
    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: OWNER_ACCESS_TOKEN, service: "notion" },
      { provider: makeFakeProvider(), listConnectionsForUser: async () => [], updateConnectionStatus: async () => {} }
    );

    results.push(
      check(
        "[N] disconnectも未対応serviceをfail closedする(provisioning/resolverと同じ既存contract)",
        outcome.status === "unsupported_service"
      )
    );
  }

  return summarize("integration/connectionLifecycle", results);

}
