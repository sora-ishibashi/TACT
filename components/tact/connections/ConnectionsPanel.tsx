"use client";

// =========================
// ConnectionsPanel (PRODUCT-P1: Connection UX)
// =========================
//
// 普通のユーザーがTACT Web上だけで
//   未接続 -> 接続する -> OAuth -> 接続済み
// を完結できる、Gmail/SlackのConnection管理UI。
//
// ユーザーは以下を一切知らない(絶対条件): Supabase・Composio・
// Connected Account ID・provider_connection_ref・Auth Config ID・
// confirm API・tact_connections。このcomponentはGET/POST
// /api/tact/connections・POST /api/tact/connections/[id]/confirm・
// POST /api/tact/connections/disconnectという既存/新規の
// canonical APIだけを呼ぶ(Composio SDK・Supabaseクライアントは
// 一切importしない)。
//
// TACT owns: canonical connection state / status / replacement
// lifecycle(server側、core/tact-integration/provisioning.ts)。
// このcomponentは「ユーザー操作を受け取り、既存APIを呼び、結果を
// 表示する」以上のことをしない(絶対条件、UI owns: user interaction
// only)。

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { INTEGRATION_CATALOG } from "./integrationCatalog";
import { aggregateConnectionStatus, type AggregatableConnection, type ConnectionUiStatus } from "./aggregateConnectionStatus";
import { describeConnectionActionError, describeConnectionListError } from "./connectionErrorMessages";

// OAuth Return Flow(PRODUCT-P1指示Section3): confirmを必要最小限だけ
// pollingする。無制限にProvider/DBを叩かない(絶対条件)。
const CONFIRM_MAX_ATTEMPTS = 8;
const CONFIRM_POLL_INTERVAL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// catalog上のどのserviceとも一致しないsentinel値(confirmingServiceの
// 初期値専用)。
const CONFIRMING_SERVICE_UNKNOWN = "__unknown__";

const STATUS_LABEL: Record<ConnectionUiStatus, string> = {
  not_connected: "未接続",
  connecting: "接続中",
  connected: "接続済み",
  error: "エラー",
};

const STATUS_COLOR: Record<ConnectionUiStatus, string> = {
  not_connected: "#8A8A8A",
  connecting: "#626161",
  connected: "#18B5A6",
  error: "#C53F4B",
};

export default function ConnectionsPanel() {

  const { user, getAccessToken } = useAuth();

  const [connections, setConnections] = useState<AggregatableConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // serviceごとのbusy状態(connect/reconnect/disconnectいずれかが
  // 進行中)。二重クリック防止(絶対条件6 Concurrency、最低限UI button
  // disable)。
  const [busyService, setBusyService] = useState<string | null>(null);

  // OAuth Return後、confirm/pollingが進行中のservice(busyServiceとは
  // 別に管理する——ページ読み込み直後、ユーザー操作を介さずに始まる
  // ため)。
  const [confirmingService, setConfirmingService] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);

  // React 18 Strict Modeの開発時二重実行でconfirmを2回走らせない
  // ためのガード(実運用上のservice呼び出し回数を安定させる、絶対条件
  // 「無制限なProvider呼び出しを増やさない」の精神を開発時にも保つ)。
  const oauthReturnHandledRef = useRef(false);

  const refreshConnections = useCallback(async () => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setConnections([]);
      setLoading(false);
      return;
    }

    setLoadError(null);

    try {

      const response = await fetch("/api/tact/connections", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setLoadError(describeConnectionListError());
        setConnections([]);
        return;
      }

      setConnections(Array.isArray(body.connections) ? body.connections : []);

    } catch {

      setLoadError(describeConnectionListError());
      setConnections([]);

    } finally {

      setLoading(false);

    }

  }, [getAccessToken]);

  useEffect(() => {

    function loadInitialConnections() {
      setLoading(true);
      refreshConnections();
    }

    loadInitialConnections();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // OAuth Return Flow(PRODUCT-P1指示Section3): callbackUrlへ埋め込んだ
  // connectionId(core/tact-integration/provisioning.tsのcreateIntegration
  // ConnectionLink()が付与)をここで読み取り、confirm APIを実行する。
  // ブラウザからproviderConnectionRefを送ることは無い——ここで扱う
  // connectionIdはTACT-owned canonical idであり、confirm API自体が
  // 呼び出しごとに所有者を再検証する(既存契約のまま)。
  const confirmConnection = useCallback(async (connectionId: string) => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    // どのserviceのconnectionIdかはUIからは分からない(絶対条件:
    // providerConnectionRefは送らない、connectionId自体はopaqueな
    // 値として扱う)ため、confirm APIの応答(connection.service)から
    // 判明した時点で正しいcardへ表示を絞り込む。それまでは
    // どのcatalog entryのserviceとも一致しないsentinelにしておく
    // (誤って特定のcardへ「確認しています」を早期表示しない)。
    setConfirmingService(CONFIRMING_SERVICE_UNKNOWN);
    setActionError(null);

    for (let attempt = 0; attempt < CONFIRM_MAX_ATTEMPTS; attempt++) {

      try {

        const response = await fetch(`/api/tact/connections/${connectionId}/confirm`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const body = await response.json().catch(() => null);

        if (typeof body?.connection?.service === "string") {
          setConfirmingService(body.connection.service);
        }

        if (response.ok && body?.success) {

          if (body.connection?.status === "active") {

            setConfirmingService(null);
            await refreshConnections();
            return;

          }

          // まだpending(Provider側のOAuth完了反映待ち)。次のattemptへ。

        } else if (response.status === 404) {

          // Connectionが見つからない(所有者不一致含む) -> raw詳細を
          // 見せず、固定の失敗文言のみ表示する。
          setConfirmingService(null);
          setActionError(describeConnectionActionError("provider_failed"));
          return;

        }
        // その他のHTTP status(500等)は一時的な障害の可能性がある
        // ため、残りattemptの範囲でretryする。

      } catch {

        // network hiccup。残りattemptの範囲でretryする。

      }

      if (attempt < CONFIRM_MAX_ATTEMPTS - 1) {
        await sleep(CONFIRM_POLL_INTERVAL_MS);
      }

    }

    // 必要最小限のpollingを使い切ってもactiveにならなかった。
    setConfirmingService(null);
    setActionError(describeConnectionActionError("confirm_timeout"));
    await refreshConnections();

  }, [getAccessToken, refreshConnections]);

  useEffect(() => {

    function startOauthReturnConfirmation() {

      if (typeof window === "undefined" || oauthReturnHandledRef.current) {
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const connectionId = params.get("connectionId");

      if (!connectionId) {
        return;
      }

      oauthReturnHandledRef.current = true;

      // URLからconnectionIdを取り除く(再読み込みで再度confirmを
      // 走らせない、絶対条件: 無制限なProvider呼び出しを増やさない)。
      const cleanedUrl = new URL(window.location.href);
      cleanedUrl.searchParams.delete("connectionId");
      window.history.replaceState(null, "", cleanedUrl.toString());

      confirmConnection(connectionId);

    }

    startOauthReturnConfirmation();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback(async (service: string) => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      setActionError("ログイン後にご利用いただけます。");
      return;
    }

    setBusyService(service);
    setActionError(null);

    try {

      const response = await fetch("/api/tact/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ service }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success || typeof body.redirectUrl !== "string") {
        setActionError(describeConnectionActionError("provider_failed"));
        setBusyService(null);
        return;
      }

      // OAuthへ遷移する(ページ自体が離脱するため、ここでbusyServiceを
      // 戻す必要は無い)。
      window.location.href = body.redirectUrl;

    } catch {

      setActionError(describeConnectionActionError("provider_failed"));
      setBusyService(null);

    }

  }, [getAccessToken]);

  const handleDisconnect = useCallback(async (service: string) => {

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setBusyService(service);
    setActionError(null);

    try {

      const response = await fetch("/api/tact/connections/disconnect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ service }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setActionError(describeConnectionActionError("provider_failed"));
        return;
      }

      await refreshConnections();

    } catch {

      setActionError(describeConnectionActionError("provider_failed"));

    } finally {

      setBusyService(null);

    }

  }, [getAccessToken, refreshConnections]);

  if (!user) {

    return (
      <p className="text-sm text-[#626161]">
        ログイン後にConnectionsを管理できます。
      </p>
    );

  }

  return (

    <div className="flex flex-col gap-4">

      <div>
        <h2 className="text-[13px] font-medium leading-[18px] text-[#112278]">Connections</h2>
      </div>

      {actionError && (
        <div className="rounded-xl border border-[#C53F4B]/30 bg-[#C53F4B]/5 px-4 py-3 text-sm text-[#C53F4B]">
          {actionError}
        </div>
      )}

      {loading ? (

        <p className="text-sm text-[#626161]">読み込んでいます...</p>

      ) : loadError ? (

        <p className="text-sm text-[#C53F4B]">{loadError}</p>

      ) : (

        <div className="flex flex-col gap-3">

          {INTEGRATION_CATALOG.filter((entry) => entry.enabled).map((entry) => {

            const uiStatus = aggregateConnectionStatus(connections, entry.service);
            const isBusy = busyService === entry.service;
            const isConfirming = confirmingService === entry.service;
            const disabled = isBusy || isConfirming || confirmingService === CONFIRMING_SERVICE_UNKNOWN;

            return (

              <div
                key={entry.service}
                className="flex items-center justify-between rounded-xl border border-[#D9D9D9] bg-white px-4 py-3"
              >

                <div className="flex min-w-0 flex-col gap-0.5">

                  <span className="text-sm font-medium text-[#112278]">{entry.name}</span>
                  <span className="text-xs text-[#626161]">{entry.description}</span>

                  <span
                    className="mt-1 text-[10px] font-medium"
                    style={{ color: STATUS_COLOR[uiStatus] }}
                  >
                    {isConfirming ? "確認しています..." : STATUS_LABEL[uiStatus]}
                  </span>

                  {uiStatus === "error" && !isConfirming && (
                    <span className="text-[10px] text-[#C53F4B]">
                      {describeConnectionActionError("multiple_active")}
                    </span>
                  )}

                </div>

                <div className="flex shrink-0 items-center gap-2">

                  {uiStatus === "connected" ? (

                    <>
                      <button
                        type="button"
                        onClick={() => handleConnect(entry.service)}
                        disabled={disabled}
                        className="h-8 rounded-[10px] border border-[#D9D9D9] px-3 text-[13px] font-medium text-[#112278] transition duration-150 ease-out hover:bg-[#E6F2F2] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        再接続
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDisconnect(entry.service)}
                        disabled={disabled}
                        className="h-8 rounded-[10px] border border-[#D9D9D9] px-3 text-[13px] font-medium text-[#C53F4B] transition duration-150 ease-out hover:bg-[#C53F4B]/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        解除
                      </button>
                    </>

                  ) : uiStatus === "error" ? (

                    <button
                      type="button"
                      onClick={() => handleConnect(entry.service)}
                      disabled={disabled}
                      className="h-8 rounded-[10px] bg-[#18B5A6] px-3 text-[13px] font-medium text-white transition duration-150 ease-out hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      再接続
                    </button>

                  ) : (

                    <button
                      type="button"
                      onClick={() => handleConnect(entry.service)}
                      disabled={disabled}
                      className="h-8 rounded-[10px] bg-[#18B5A6] px-3 text-[13px] font-medium text-white transition duration-150 ease-out hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {uiStatus === "connecting" ? "続ける" : "接続する"}
                    </button>

                  )}

                </div>

              </div>

            );

          })}

        </div>

      )}

    </div>

  );

}
