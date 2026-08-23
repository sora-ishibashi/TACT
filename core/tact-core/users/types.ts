// =========================
// TACT Core — User / Organization (STEP175)
// =========================
//
// これは既存のcore/auth/getUserContext.tsのUserContextとは別物として
// 意図的に定義する。UserContextは「1リクエスト中に検証されたuserId/
// emailのスナップショット」(未認証時はnull、Organization/Workspaceは
// 未実装の予約フィールド)であり、リクエスト境界の外では意味を持たない。
// 一方ここで定義するUserは、TACT Coreが横断的に参照する「永続化された
// ユーザーという概念」を表す、ドメイン型である。
//
// STEP175時点では型定義のみで、実データ取得ロジック・DB接続は持たない
// (core/tact-core/mockCoreCapability.tsが型契約確認用の最小実装を持つ
// だけで、Supabase等への実接続はまだ行わない)。
//
// 将来の接続方針(コメントのみ、今回は実装しない):
//   User.id ← core/auth/getAuthenticatedUser.tsが検証するuserId
//            (auth.users.id)をそのまま使う想定。新しいユーザーテーブルは
//            作らず、既存のauth.usersを土台にする。

export interface Organization {

  id: string;

  name: string;

  createdAt: string;

}

export interface User {

  id: string;

  // 未所属(個人利用)の場合はundefined。
  organizationId?: string;

  name?: string;

  createdAt: string;

}
