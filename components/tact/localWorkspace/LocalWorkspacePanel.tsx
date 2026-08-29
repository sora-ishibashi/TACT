"use client";

// =========================
// LocalWorkspacePanel (LW-P1 / LW-P2)
// =========================
//
// TACT Core内の「接続・Context・権限を管理する」窓口として、
// Local Workspace(File System Access API経由)の接続UIを提供する。
// ProductLauncherへ新sectionは追加せず、既存CoreSection内に組み込む。
//
// LW-P2で検索(search)・Safe Read Preview(read-only)を追加した。
// Research統合(実際にEvidenceとして送信する経路)はLW-P3のスコープで
// あり、このPhaseでは行わない。docs/ui-design-rules.mdの
// 色/spacing/radiusトークンに合わせる。

import { AlertCircle, FileText, Folder, FolderOpen, Link2, RefreshCw, Search, Unlink, X } from "lucide-react";
import { useState } from "react";

import type { ContextSourceEntryMetadata, ContextSourceTreeNode } from "@/core/tact-context-source";
import { useLocalWorkspace } from "./useLocalWorkspace";

function formatBytes(size: number): string {

  if (size < 1024) {
    return `${size}B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)}MB`;

}

function formatTimestamp(iso?: string): string {

  if (!iso) {
    return "-";
  }

  try {
    return new Date(iso).toLocaleString("ja-JP", { hour12: false });
  } catch {
    return iso;
  }

}

function TreeNodeView({
  node,
  depth,
  onSelectFile,
}: {
  node: ContextSourceTreeNode;
  depth: number;
  onSelectFile: (relativePath: string) => void;
}) {

  // rootのみ既定で展開、それ以外は折りたたんでおく(大きなWorkspaceでも
  // 最初から全展開しないため)。
  const [open, setOpen] = useState(depth === 0);
  const isDirectory = node.type === "directory";

  return (
    <div>

      <div
        className="flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-[13px] leading-[18px] text-[#112278] hover:bg-[#E6F2F2]"
        style={{ paddingLeft: 6 + depth * 16 }}
      >

        {isDirectory ? (

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {open ? (
              <FolderOpen size={16} strokeWidth={2} className="shrink-0 text-[#626161]" />
            ) : (
              <Folder size={16} strokeWidth={2} className="shrink-0 text-[#626161]" />
            )}
            <span className="truncate">{node.name}</span>
          </button>

        ) : (

          <button
            type="button"
            onClick={() => onSelectFile(node.relativePath)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <FileText size={16} strokeWidth={2} className="shrink-0 text-[#626161]" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {typeof node.entry?.size === "number" && (
              <span className="shrink-0 text-[12px] text-[#8A8A8A]">
                {formatBytes(node.entry.size)}
              </span>
            )}
          </button>

        )}

      </div>

      {isDirectory && open && node.children?.map((child) => (
        <TreeNodeView key={child.relativePath} node={child} depth={depth + 1} onSelectFile={onSelectFile} />
      ))}

    </div>
  );

}

function SearchResultRow({
  entry,
  onSelectFile,
}: {
  entry: ContextSourceEntryMetadata;
  onSelectFile: (relativePath: string) => void;
}) {

  const isDirectory = entry.type === "directory";

  return (
    <button
      type="button"
      onClick={() => !isDirectory && onSelectFile(entry.relativePath)}
      disabled={isDirectory}
      className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-[#112278] hover:bg-[#E6F2F2] disabled:cursor-default disabled:hover:bg-transparent"
    >
      {isDirectory ? (
        <Folder size={16} strokeWidth={2} className="shrink-0 text-[#626161]" />
      ) : (
        <FileText size={16} strokeWidth={2} className="shrink-0 text-[#626161]" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{entry.name}</span>
        <span className="block truncate text-[12px] text-[#8A8A8A]">{entry.relativePath}</span>
      </span>
      {typeof entry.size === "number" && (
        <span className="shrink-0 text-[12px] text-[#8A8A8A]">{formatBytes(entry.size)}</span>
      )}
    </button>
  );

}

const PRIMARY_BUTTON_CLASS =
  "flex h-9 items-center gap-2 rounded-[10px] bg-[#18B5A6] px-3 text-[14px] font-medium text-white transition hover:border hover:border-[#18B5A6] hover:bg-white hover:text-[#18B5A6] disabled:cursor-not-allowed disabled:opacity-60";

const SECONDARY_BUTTON_CLASS =
  "flex h-8 items-center gap-1.5 rounded-[10px] border border-[#D9D9D9] bg-white px-3 text-[13px] font-medium text-[#112278] transition hover:bg-[#E6F2F2] disabled:cursor-not-allowed disabled:opacity-60";

export default function LocalWorkspacePanel() {

  const {
    state,
    connect,
    reauthorize,
    rescan,
    disconnect,
    changeFolder,
    searchState,
    setSearchQuery,
    clearSearch,
    previewState,
    openPreview,
    closePreview,
  } = useLocalWorkspace();

  return (
    <div>

      <h3 className="text-[13px] font-medium leading-[18px] text-[#112278]">Local Workspace</h3>

      {state.status === "checking" && (
        <p className="mt-2 text-[13px] leading-[18px] text-[#626161]">確認中...</p>
      )}

      {state.status === "unsupported" && (
        <div className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-[#626161]">
          <AlertCircle size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-[#C53F4B]" />
          <p>
            このブラウザはLocal Workspace接続に対応していません。
            Google Chrome または Microsoft Edge の最新版でお試しください。
          </p>
        </div>
      )}

      {(state.status === "idle" || state.status === "connecting") && (
        <button
          type="button"
          onClick={connect}
          disabled={state.status === "connecting"}
          className={`mt-2 ${PRIMARY_BUTTON_CLASS}`}
        >
          <Link2 size={16} strokeWidth={2} />
          {state.status === "connecting" ? "接続中..." : "フォルダを接続"}
        </button>
      )}

      {state.status === "needs_permission" && (
        <div className="mt-2">
          <div className="flex items-start gap-2 text-[13px] leading-[18px] text-[#C53F4B]">
            <AlertCircle size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
            <p>前回接続した「{state.rootLabel ?? "Workspace"}」への読み取り許可が切れています。</p>
          </div>
          <button type="button" onClick={reauthorize} className={`mt-2 ${PRIMARY_BUTTON_CLASS}`}>
            <Link2 size={16} strokeWidth={2} />
            再許可
          </button>
        </div>
      )}

      {state.status === "error" && (
        <div className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-[#C53F4B]">
          <AlertCircle size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
          <p>{state.errorMessage ?? "エラーが発生しました。"}</p>
        </div>
      )}

      {state.status === "connected" && (
        <div className="mt-2">

          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px] leading-[18px] text-[#112278]">
            <span>Workspace名: <span className="font-medium">{state.rootLabel}</span></span>
            <span className="text-[#18B5A6]">接続状態: 接続済み</span>
            <span className="text-[#626161]">Read-only</span>
            <span className="text-[#626161]">
              ファイル数: {state.fileCount}{state.scanTruncated ? "+" : ""}
            </span>
            <span className="text-[#626161]">最終scan: {formatTimestamp(state.lastScannedAt)}</span>
          </div>

          {state.errorMessage && (
            <p className="mt-1 text-[13px] text-[#C53F4B]">{state.errorMessage}</p>
          )}

          <div className="mt-2 flex gap-2">

            <button
              type="button"
              onClick={rescan}
              disabled={state.scanning}
              className={SECONDARY_BUTTON_CLASS}
            >
              <RefreshCw size={16} strokeWidth={2} className={state.scanning ? "animate-spin" : undefined} />
              再スキャン
            </button>

            <button type="button" onClick={changeFolder} className={SECONDARY_BUTTON_CLASS}>
              変更
            </button>

            <button
              type="button"
              onClick={disconnect}
              className={`${SECONDARY_BUTTON_CLASS} text-[#C53F4B]`}
            >
              <Unlink size={16} strokeWidth={2} />
              切断
            </button>

          </div>

          {/* Workspace内検索(LW-P2)。metadata一致 + 軽量content indexに
              よる本文一致。LLM/Search APIは使わない。 */}
          <div className="relative mt-3">
            <Search size={16} strokeWidth={2} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8A8A8A]" />
            <input
              type="text"
              value={searchState.query}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Workspace内を検索(ファイル名・パス・拡張子・本文)"
              className="h-9 w-full rounded-[12px] border border-[#D9D9D9] bg-white pl-9 pr-9 text-[13px] leading-[18px] text-[#112278] outline-none focus:border-[#18B5A6]"
            />
            {searchState.query && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="検索をクリア"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[8px] text-[#8A8A8A] hover:bg-[#E6F2F2]"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>

          {searchState.query && (

            <div className="mt-2 max-h-56 overflow-y-auto rounded-[12px] border border-[#D9D9D9] p-1.5">

              {searchState.searching && (
                <p className="px-2 py-1 text-[13px] text-[#626161]">検索中...</p>
              )}

              {searchState.errorMessage && (
                <p className="px-2 py-1 text-[13px] text-[#C53F4B]">{searchState.errorMessage}</p>
              )}

              {!searchState.searching && !searchState.errorMessage && searchState.results.length === 0 && (
                <p className="px-2 py-1 text-[13px] text-[#626161]">一致するファイルが見つかりません。</p>
              )}

              {!searchState.searching && searchState.results.map((entry) => (
                <SearchResultRow key={entry.relativePath} entry={entry} onSelectFile={openPreview} />
              ))}

            </div>

          )}

          {/* File tree(既存)。検索queryが空の時のみ表示する
              (検索結果と二重に出さないため)。 */}
          {!searchState.query && (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-[12px] border border-[#D9D9D9] p-1.5">
              {state.tree.length === 0 ? (
                <p className="px-2 py-1 text-[13px] text-[#626161]">表示できるファイルがありません。</p>
              ) : (
                state.tree.map((node) => (
                  <TreeNodeView key={node.relativePath} node={node} depth={0} onSelectFile={openPreview} />
                ))
              )}
            </div>
          )}

          {/* Safe Read Preview(read-only)。LW-P2。 */}
          {previewState.status !== "idle" && (

            <div className="mt-3 rounded-[12px] border border-[#D9D9D9] p-3">

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium leading-[18px] text-[#112278]">
                    {previewState.entry?.name ?? "Preview"}
                  </p>
                  {previewState.entry && (
                    <p className="truncate text-[12px] text-[#8A8A8A]">{previewState.entry.relativePath}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={closePreview}
                  aria-label="Previewを閉じる"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] text-[#8A8A8A] hover:bg-[#E6F2F2]"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>

              {previewState.status === "loading" && (
                <p className="mt-2 text-[13px] text-[#626161]">読み込み中...</p>
              )}

              {previewState.status === "error" && (
                <div className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-[#C53F4B]">
                  <AlertCircle size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
                  <p>{previewState.errorMessage ?? "読み取りに失敗しました。"}</p>
                </div>
              )}

              {previewState.status === "loaded" && previewState.entry && (
                <>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#8A8A8A]">
                    {typeof previewState.entry.size === "number" && (
                      <span>{formatBytes(previewState.entry.size)}</span>
                    )}
                    {previewState.entry.extension && <span>.{previewState.entry.extension}</span>}
                    <span>最終更新: {formatTimestamp(previewState.entry.modifiedAt)}</span>
                  </div>

                  {previewState.truncated && (
                    <p className="mt-1 text-[12px] text-[#C53F4B]">
                      内容が大きいため、先頭部分のみ表示しています。
                    </p>
                  )}

                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[#F2F2F2] p-2 text-[12px] leading-[18px] text-[#112278]">
                    {previewState.content}
                  </pre>
                </>
              )}

            </div>

          )}

        </div>
      )}

    </div>
  );

}
