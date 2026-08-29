// =========================
// TACT Context Source — Common Contract (LW-P0)
// =========================
//
// 目的: Local Workspace / Drive / Slack / GitHub等、将来複数の
// Context取得元を「同じ形」で扱うための共通契約。DOM/Browser API/
// Node fs/DBのいずれにも依存しないpure typeのみをここに置く。
//
// このファイル、およびcore/tact-context-source/配下のどのファイルも、
// core/tact-core・core/tact-research・core/tact-attachment・
// core/conversation等を一切importしない(Coreの他モジュールと同じ
// 「境界だけを持つ」設計方針を踏襲する)。Evidence変換
// (localWorkspace/toEvidence.ts)のためだけに、core/context/types.tsの
// 既存Evidence型を参照する。
//
// 実装(実際にBrowser File System Access APIやTACT Local Agentと
// 通信する部分)はここには置かない。LW-P0時点ではContextSourceは
// interfaceのみであり、実装クラスは将来のPhase(Browser adapter /
// Local Agent adapter)で追加する。

export type ContextSourceKind =
  | "local_workspace"
  | "drive"
  | "github"
  | "slack";

// =========================
// Permissions
// =========================
//
// 最低限read/write/delete/git/terminalの5軸を表現できるようにする。
// LW-P0では read=true・それ以外=false の固定値しか使わない
// (write/delete/git/terminalを実行するAPIはこのPhaseでは作らない)。
export interface ContextSourcePermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
  git: boolean;
  terminal: boolean;
}

// Local Workspace MVPのdefault(および他ContextSourceのread-only
// default)として共通利用する、意図しない書き換えを防ぐためfreezeした
// 定数。個別のContextSource実装は、これをそのまま使うか、
// スプレッドしてコピーしてから上書きする(このオブジェクト自体は
// 変更しない)。
export const READ_ONLY_PERMISSIONS: Readonly<ContextSourcePermissions> = Object.freeze({
  read: true,
  write: false,
  delete: false,
  git: false,
  terminal: false,
});

// =========================
// Connection
// =========================

export interface ContextSourceConnection {
  id: string;
  kind: ContextSourceKind;
  // ユーザーへ表示するための名称(例: 選択したフォルダ名)。
  // 絶対path等、Workspace外へ露出すべきでない情報は含めない。
  label: string;
  connectedAt: string;
  permissions: ContextSourcePermissions;
}

// =========================
// Entry metadata
// =========================
//
// 絶対pathを共通Contextへ露出する設計は避ける。Workspace rootからの
// relativePathを基本とし、OS依存の絶対path処理はCoreに持ち込まない。
export type ContextSourceEntryType = "file" | "directory";

export interface ContextSourceEntryMetadata {
  name: string;
  relativePath: string;
  type: ContextSourceEntryType;
  size?: number;
  modifiedAt?: string;
  mimeType?: string;
  extension?: string;
}

export interface ContextSourceReadResult {
  entry: ContextSourceEntryMetadata;
  content: string;
  truncated: boolean;
}

export interface ContextSourceSearchParams {
  query: string;
  limit?: number;
}

// =========================
// ContextSource interface
// =========================
//
// 将来のBrowser LocalWorkspaceAdapter・TACT Local Agent Adapterの
// どちらでも実装できるよう、DOM/Node固有の型を一切引数・戻り値に
// 含めない(FileSystemHandle等はここに現れない)。
export interface ContextSource {
  readonly kind: ContextSourceKind;
  readonly permissions: ContextSourcePermissions;

  connect(): Promise<ContextSourceConnection>;

  disconnect(): Promise<void>;

  // relativePath省略時はroot直下の一覧を返す想定。
  list(relativePath?: string): Promise<ContextSourceEntryMetadata[]>;

  search(params: ContextSourceSearchParams): Promise<ContextSourceEntryMetadata[]>;

  read(relativePath: string): Promise<ContextSourceReadResult>;
}
