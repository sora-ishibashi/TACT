"use client";

// =========================
// useLocalWorkspace (LW-P1)
// =========================
//
// TACT CoreのUIから、core/tact-context-source/localWorkspace/
// browserAdapter.tsを操作するためのReact hook。Browser固有型
// (FileSystemDirectoryHandle等)はadapter/handleStore側に閉じ込め、
// ここではそれらの戻り値(ContextSourceEntryMetadata・
// LocalWorkspaceConnection等、DOM非依存の型)だけを扱う。
//
// 安全設計(LW-P1絶対条件):
// - connect()・reauthorize()は、必ずボタンclick等のユーザー操作
//   ハンドラからのみ呼び出す(このhook自体は自動実行しない)。
// - マウント時の復元(restore)はqueryPermissionのみ(無音)で確認し、
//   permissionがgranted済みの場合だけ自動でscanまで行う。
//   grantedでない場合はrequestPermission()を一切呼ばず、
//   "needs_permission"状態にしてユーザーの操作を待つ。
//
// LW-P2で追加した検索(search)・Safe Read(preview)も、この方針を
// 継続する: search()はconnected状態でのみ実行し、読み取りは
// adapter.read()(relativePath validation・default exclude・
// permission再確認等をbrowserAdapter.ts側で保証済み)を経由する以外の
// 経路を作らない。Research等への送信はここでは一切行わない
// (previewはread-onlyの表示のみ)。

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkStoredPermission,
  createBrowserLocalWorkspaceAdapter,
  isFileSystemAccessSupported,
  type LocalWorkspaceBrowserAdapter,
} from "@/core/tact-context-source/localWorkspace/browserAdapter";
import {
  clearWorkspaceHandle,
  loadWorkspaceHandle,
  saveWorkspaceHandle,
} from "@/core/tact-context-source/localWorkspace/handleStore";
import {
  LocalWorkspaceCancelledError,
  LocalWorkspacePermissionDeniedError,
  LocalWorkspaceUnsupportedError,
} from "@/core/tact-context-source/localWorkspace/errors";
import type {
  LocalWorkspaceConnection,
  LocalWorkspaceResolvedContext,
} from "@/core/tact-context-source/localWorkspace/types";
import { contextSourceReadResultToEvidence } from "@/core/tact-context-source/localWorkspace/toEvidence";
import {
  buildContextSourceEntryTree,
  type ContextSourceEntryMetadata,
  type ContextSourceReadResult,
  type ContextSourceTreeNode,
  type LocalWorkspaceEvidence,
} from "@/core/tact-context-source";

// 入力の都度searchを実行するとcontent indexの再構築コストが積み重なる
// ため、UI側でdebounceする(core/adapter側の責務にはしない)。
const SEARCH_DEBOUNCE_MS = 300;

export type LocalWorkspaceStatus =
  | "checking"
  | "unsupported"
  | "idle"
  | "connecting"
  | "needs_permission"
  | "connected"
  | "error";

export interface LocalWorkspaceState {
  status: LocalWorkspaceStatus;
  // search/previewのEvidence変換(contextSourceReadResultToEvidence)に
  // workspaceIdが必要なため保持する。
  workspaceId?: string;
  rootLabel?: string;
  connectedAt?: string;
  fileCount: number;
  entries: ContextSourceEntryMetadata[];
  tree: ContextSourceTreeNode[];
  lastScannedAt?: string;
  scanning: boolean;
  scanTruncated: boolean;
  errorMessage?: string;
}

const INITIAL_STATE: LocalWorkspaceState = {
  status: "checking",
  fileCount: 0,
  entries: [],
  tree: [],
  scanning: false,
  scanTruncated: false,
};

// =========================
// Search (LW-P2)
// =========================

export interface LocalWorkspaceSearchState {
  query: string;
  results: ContextSourceEntryMetadata[];
  searching: boolean;
  errorMessage?: string;
}

const INITIAL_SEARCH_STATE: LocalWorkspaceSearchState = {
  query: "",
  results: [],
  searching: false,
};

// =========================
// Preview (LW-P2 Safe Read)
// =========================

export type LocalWorkspacePreviewStatus = "idle" | "loading" | "loaded" | "error";

export interface LocalWorkspacePreviewState {
  status: LocalWorkspacePreviewStatus;
  entry?: ContextSourceEntryMetadata;
  content?: string;
  truncated?: boolean;
  errorMessage?: string;
}

const INITIAL_PREVIEW_STATE: LocalWorkspacePreviewState = {
  status: "idle",
};

function describeConnectError(error: unknown): string {

  if (error instanceof Error) {
    return error.message;
  }

  return "不明なエラーが発生しました。";

}

export function useLocalWorkspace() {

  const [state, setState] = useState<LocalWorkspaceState>(INITIAL_STATE);
  const [searchState, setSearchState] = useState<LocalWorkspaceSearchState>(INITIAL_SEARCH_STATE);
  const [previewState, setPreviewState] =
    useState<LocalWorkspacePreviewState>(INITIAL_PREVIEW_STATE);
  const adapterRef = useRef<LocalWorkspaceBrowserAdapter | null>(null);
  // previewをEvidenceへ変換する際に必要な、read()の生の戻り値
  // (ContextSourceReadResult)。UI表示用のpreviewState.contentとは別に
  // 保持する(entry.typeがnarrowされた形をtoEvidence側がそのまま
  // 使えるようにするため)。
  const lastReadResultRef = useRef<ContextSourceReadResult | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);

  const persist = useCallback(
    async (adapter: LocalWorkspaceBrowserAdapter, connection: LocalWorkspaceConnection) => {

      if (!adapter.directoryHandle) {
        return;
      }

      await saveWorkspaceHandle({
        workspaceId: connection.id,
        rootLabel: connection.rootLabel,
        connectedAt: connection.connectedAt,
        directoryHandle: adapter.directoryHandle,
      });

    },
    []
  );

  const runScan = useCallback(
    async (adapter: LocalWorkspaceBrowserAdapter, connection: LocalWorkspaceConnection) => {

      setState((prev) => ({ ...prev, status: "connected", scanning: true, errorMessage: undefined }));

      const result = await adapter.scan();

      setState({
        status: "connected",
        workspaceId: connection.id,
        rootLabel: connection.rootLabel,
        connectedAt: connection.connectedAt,
        fileCount: result.fileCount,
        entries: result.entries,
        tree: buildContextSourceEntryTree(result.entries),
        lastScannedAt: result.scannedAt,
        scanning: false,
        scanTruncated: result.truncated,
      });

    },
    []
  );

  const handleConnectError = useCallback((error: unknown, fallbackRootLabel?: string) => {

    if (error instanceof LocalWorkspaceCancelledError) {
      // キャンセルはエラーではない。permission待ちの状態が既にあれば
      // それを維持し、無ければidleへ戻す。
      setState((prev) => ({
        ...prev,
        status: fallbackRootLabel ? "needs_permission" : "idle",
        errorMessage: undefined,
      }));
      return;
    }

    if (error instanceof LocalWorkspaceUnsupportedError) {
      setState((prev) => ({ ...prev, status: "unsupported" }));
      return;
    }

    if (error instanceof LocalWorkspacePermissionDeniedError) {
      setState((prev) => ({
        ...prev,
        status: fallbackRootLabel ? "needs_permission" : "idle",
        errorMessage: "フォルダへの読み取り許可が得られませんでした。",
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      status: "error",
      errorMessage: describeConnectError(error),
    }));

  }, []);

  // =========================
  // 起動時の復元(persisted handle)
  // =========================
  useEffect(() => {

    let cancelled = false;

    async function restore() {

      if (!isFileSystemAccessSupported()) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, status: "unsupported" }));
        }
        return;
      }

      const stored = await loadWorkspaceHandle();

      if (cancelled) {
        return;
      }

      if (!stored) {
        setState((prev) => ({ ...prev, status: "idle" }));
        return;
      }

      // 無音確認のみ(requestPermissionは呼ばない)。
      const permission = await checkStoredPermission(stored.directoryHandle);

      if (cancelled) {
        return;
      }

      const adapter = createBrowserLocalWorkspaceAdapter({
        directoryHandle: stored.directoryHandle,
        workspaceId: stored.workspaceId,
      });

      adapterRef.current = adapter;

      if (permission !== "granted") {
        setState((prev) => ({
          ...prev,
          status: "needs_permission",
          rootLabel: stored.rootLabel,
          connectedAt: stored.connectedAt,
        }));
        return;
      }

      try {

        // permissionが既にgranted済みのため、connect()はqueryのみで
        // requestPermission()を呼ばない(ユーザー操作不要)。
        const connection = await adapter.connect();

        if (cancelled) {
          return;
        }

        await runScan(adapter, connection);

      } catch (error) {

        if (!cancelled) {
          handleConnectError(error, stored.rootLabel);
        }

      }

    }

    restore();

    return () => {
      cancelled = true;
    };

  }, [handleConnectError, runScan]);

  // =========================
  // Actions
  // =========================

  // 新規接続、および「変更」(別フォルダへの再選択)の両方で使う。
  // 常にshowDirectoryPicker()を呼ぶため、必ずユーザー操作(button
  // click)から呼び出すこと。
  const connect = useCallback(async () => {

    setState((prev) => ({ ...prev, status: "connecting", errorMessage: undefined }));

    try {

      const adapter = createBrowserLocalWorkspaceAdapter();
      const connection = await adapter.connect();

      adapterRef.current = adapter;

      await persist(adapter, connection);
      await runScan(adapter, connection);

    } catch (error) {
      handleConnectError(error);
    }

  }, [handleConnectError, persist, runScan]);

  // 永続化されていたhandleへの再許可。既にhandleを保持している
  // adapterに対してのみ有効(=needs_permission状態からのみ呼ぶ)。
  // ボタンclickというユーザー操作を経て呼ばれるため、内部で
  // requestPermission()を呼んでよい。
  const reauthorize = useCallback(async () => {

    const adapter = adapterRef.current;

    if (!adapter) {
      return;
    }

    setState((prev) => ({ ...prev, status: "connecting", errorMessage: undefined }));

    try {

      const connection = await adapter.connect();

      await persist(adapter, connection);
      await runScan(adapter, connection);

    } catch (error) {
      handleConnectError(error, state.rootLabel);
    }

  }, [handleConnectError, persist, runScan, state.rootLabel]);

  const rescan = useCallback(async () => {

    const adapter = adapterRef.current;

    if (!adapter || state.status !== "connected") {
      return;
    }

    setState((prev) => ({ ...prev, scanning: true, errorMessage: undefined }));

    try {

      const result = await adapter.scan();

      setState((prev) => ({
        ...prev,
        scanning: false,
        fileCount: result.fileCount,
        entries: result.entries,
        tree: buildContextSourceEntryTree(result.entries),
        lastScannedAt: result.scannedAt,
        scanTruncated: result.truncated,
      }));

    } catch (error) {

      setState((prev) => ({
        ...prev,
        scanning: false,
        status: "error",
        errorMessage: describeConnectError(error),
      }));

    }

  }, [state.status]);

  // =========================
  // Search (LW-P2)
  // =========================
  //
  // adapter.search()はcore/tact-context-source/search.ts(metadata)と
  // localWorkspace/contentIndex.ts(軽量content index)を経由した
  // client-side deterministic searchであり、LLM/Search APIは呼ばない。

  const runSearch = useCallback(async (query: string) => {

    const adapter = adapterRef.current;
    const trimmed = query.trim();

    if (!adapter || state.status !== "connected" || !trimmed) {
      setSearchState((prev) => ({ ...prev, results: [], searching: false, errorMessage: undefined }));
      return;
    }

    // debounce後に実行が重なった場合、最後に発行したrequestの結果のみ
    // 反映する(古いqueryの結果で新しいqueryの表示を上書きしないため)。
    const requestId = ++searchRequestIdRef.current;

    setSearchState((prev) => ({ ...prev, searching: true, errorMessage: undefined }));

    try {

      const results = await adapter.search({ query: trimmed });

      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      setSearchState((prev) => ({ ...prev, results, searching: false }));

    } catch (error) {

      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      setSearchState((prev) => ({
        ...prev,
        searching: false,
        errorMessage: describeConnectError(error),
      }));

    }

  }, [state.status]);

  // ユーザー入力のたびに即searchせず、SEARCH_DEBOUNCE_MS待ってから
  // 実行する(content indexの再構築コストを毎keystrokeで払わないため)。
  const setSearchQuery = useCallback((query: string) => {

    setSearchState((prev) => ({ ...prev, query }));

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    if (!query.trim()) {
      searchRequestIdRef.current += 1;
      setSearchState((prev) => ({ ...prev, results: [], searching: false, errorMessage: undefined }));
      return;
    }

    searchDebounceRef.current = setTimeout(() => {
      runSearch(query);
    }, SEARCH_DEBOUNCE_MS);

  }, [runSearch]);

  const clearSearch = useCallback(() => {

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    searchRequestIdRef.current += 1;
    setSearchState(INITIAL_SEARCH_STATE);

  }, []);

  // =========================
  // Preview (LW-P2 Safe Read)
  // =========================
  //
  // adapter.read()側で、relativePath validation・default exclude・
  // directory reject・拡張子/size/content上限・permission再確認を
  // 行う(ここでは結果をそのままread-only表示するだけ)。Research等へは
  // 送らない。

  const openPreview = useCallback(async (relativePath: string) => {

    const adapter = adapterRef.current;

    if (!adapter) {
      return;
    }

    setPreviewState({ status: "loading" });

    try {

      const result = await adapter.read(relativePath);

      lastReadResultRef.current = result;

      setPreviewState({
        status: "loaded",
        entry: result.entry,
        content: result.content,
        truncated: result.truncated,
      });

    } catch (error) {

      lastReadResultRef.current = null;

      setPreviewState({
        status: "error",
        errorMessage: describeConnectError(error),
      });

    }

  }, []);

  const closePreview = useCallback(() => {
    lastReadResultRef.current = null;
    setPreviewState(INITIAL_PREVIEW_STATE);
  }, []);

  // previewをLocalWorkspaceEvidenceへ変換する(呼び出すまでは変換しない)。
  // このPhaseではどこにも自動送信しない、変換可能な状態を提供するのみ。
  const getPreviewEvidence = useCallback((): LocalWorkspaceEvidence | null => {

    const result = lastReadResultRef.current;

    if (!result || !state.workspaceId) {
      return null;
    }

    return contextSourceReadResultToEvidence(state.workspaceId, result);

  }, [state.workspaceId]);

  // =========================
  // Workspace Context Resolver (LW-P3)
  // =========================
  //
  // Research等が、userInputを渡すだけでbounded LocalWorkspaceEvidence[]
  // を得るための窓口。Workspaceが接続されていない場合(adapter未生成)は
  // adapter.resolveWorkspaceContext()自体を呼ばず、即座に
  // reason:"not_connected"を返す(directoryHandleへ一切アクセスしない)。
  // 実際の意図判定・search/read・permission再確認はadapter側
  // (browserAdapter.tsのresolveWorkspaceContext())の責務。
  const resolveWorkspaceContext = useCallback(
    async (query: string): Promise<LocalWorkspaceResolvedContext> => {

      const adapter = adapterRef.current;

      if (!adapter) {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "not_connected" };
      }

      return adapter.resolveWorkspaceContext(query);

    },
    []
  );

  const disconnect = useCallback(async () => {

    const adapter = adapterRef.current;

    if (adapter) {
      await adapter.disconnect();
    }

    adapterRef.current = null;

    await clearWorkspaceHandle();

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    searchRequestIdRef.current += 1;
    lastReadResultRef.current = null;

    setState({
      status: "idle",
      fileCount: 0,
      entries: [],
      tree: [],
      scanning: false,
      scanTruncated: false,
    });
    setSearchState(INITIAL_SEARCH_STATE);
    setPreviewState(INITIAL_PREVIEW_STATE);

  }, []);

  // アンマウント時にdebounce timerを残さない。
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, []);

  return {
    state,
    connect,
    reauthorize,
    rescan,
    disconnect,
    // 「変更」ボタンはconnect()と同じ経路(新規picker選択)を使う。
    changeFolder: connect,
    searchState,
    setSearchQuery,
    clearSearch,
    previewState,
    openPreview,
    closePreview,
    getPreviewEvidence,
    resolveWorkspaceContext,
  };

}
