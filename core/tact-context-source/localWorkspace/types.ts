// =========================
// TACT Context Source — Local Workspace types (LW-P0)
// =========================
//
// Local Workspace固有の型。Browser File System Access APIの
// FileSystemHandle/FileSystemDirectoryHandle等、Browser固有の型は
// ここに一切持ち込まない(将来のclient adapter側に閉じ込める)。
// ここにあるのはDOM非依存のpure typeのみ。

import type { Evidence } from "../../context/types";
import type {
  ContextSourceConnection,
  ContextSourceEntryMetadata,
  ContextSourcePermissions,
} from "../types";
import { READ_ONLY_PERMISSIONS } from "../types";

// Local Workspace MVPのdefault permission。read=trueのみ、
// write/delete/git/terminalはfalse固定(このPhaseで変更する経路は無い)。
export const LOCAL_WORKSPACE_DEFAULT_PERMISSIONS: Readonly<ContextSourcePermissions> =
  READ_ONLY_PERMISSIONS;

export interface LocalWorkspaceConnection extends ContextSourceConnection {
  kind: "local_workspace";
  // ユーザーが選択したフォルダの表示名(例: フォルダ名のみ)。
  // 絶対pathそのものはCore型として保持しない。
  rootLabel: string;
}

export interface LocalWorkspaceFile extends ContextSourceEntryMetadata {
  type: "file";
}

export interface LocalWorkspaceReadResult {
  file: LocalWorkspaceFile;
  content: string;
  truncated: boolean;
}

// =========================
// Provenance / Evidence
// =========================
//
// Attachment pipeline(core/tact-attachment/types.ts AttachmentProvenance)
// とは意図的に別型として持つ(Attachmentは変更しない・別sourceとして
// 扱うため)。ただしEvidence本体は既存のcore/context/types.ts Evidence
// 型をそのまま再利用する。
export interface LocalWorkspaceProvenance {
  sourceType: "local_workspace";
  workspaceId: string;
  relativePath: string;
  fileName: string;
  modifiedAt?: string;
  size?: number;
}

export interface LocalWorkspaceEvidence {
  evidence: Evidence;
  provenance: LocalWorkspaceProvenance;
}

// =========================
// Workspace Context Resolver result (LW-P3)
// =========================
//
// browserAdapter.tsのresolveWorkspaceContext()の戻り値。usedがfalseの
// 場合、evidenceは常に空配列(呼び出し元はResearchへ何も追加しない)。
export type LocalWorkspaceContextResolutionReason =
  | "no_intent"
  | "not_connected"
  | "permission_revoked"
  | "no_candidates";

export interface LocalWorkspaceResolvedContext {
  used: boolean;
  evidence: LocalWorkspaceEvidence[];
  // ranking後(read前)の候補件数(threshold以上のscoreを持つfile数)。
  candidateCount: number;
  // 実際にread・Evidence化できた件数(evidence.lengthと一致)。
  readCount: number;
  reason?: LocalWorkspaceContextResolutionReason;
}
