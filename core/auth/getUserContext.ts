import { getAuthenticatedUser } from "./getAuthenticatedUser";

// =========================
// UserContext (STEP145-C)
// =========================
//
// 背景: これまでAPI Routeごとに個別へ`getAuthenticatedUser(request)`を
// 呼び出し、userIdだけを取り出す形でバラバラに実装されていた
// (STEP131〜138)。STEP145では今後Organization/Workspaceへ拡張する
// 可能性を見据え、userId取得の共通入口を一本化する。
//
// 重要: 既存の`getAuthenticatedUser()`(トークン検証本体)は変更しない。
// このファイルはその薄いラッパーであり、返す情報の形を
// UserContextとして統一するだけ。
//
// organizationId / workspaceIdはSTEP145時点では未実装のため常に
// undefined(optional)。将来Organization/Workspaceを導入した際、
// このファイルの内部実装だけを変更すれば、呼び出し元
// (API Route側)のシグネチャは変えずに済む設計とする。

export interface UserContext {
  userId: string | null;
  email: string | null;

  // Phase 31: getAuthenticatedUser()の検証結果をそのまま透過する
  // (新しい検証ロジックではない)。core/tact-project/store.tsが
  // Supabase RLS(auth.uid()、Phase30)を機能させるper-requestクライアント
  // を構築するためだけに使う。
  accessToken: string | null;

  // 将来拡張用(STEP145時点では未実装)。
  organizationId?: string;
  workspaceId?: string;
}

export async function getCurrentUserContext(
  request: Request
): Promise<UserContext> {

  const { userId, email, accessToken } =
    await getAuthenticatedUser(request);

  return {
    userId,
    email,
    accessToken,
  };

}
