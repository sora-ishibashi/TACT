import { supabase } from "../database/supabase";

// =========================
// getAuthenticatedUser (STEP131)
// =========================
//
// 背景: app/api/tact/conversation(/stream)/route.tsは、これまで
// body.userId(クライアントが送ってきた値)をそのままCreateConversation()
// に渡していた。クライアントから送られてくるuserIdは信頼できる情報では
// ない(なりすまし可能)ため、これを正規の認証手段として扱わない。
//
// 正しい構造:
//   client → Authorization: Bearer <access_token> ヘッダー
//   → server側でSupabase Auth(supabase.auth.getUser(token))により
//     トークンを検証
//   → 検証済みのuserId(auth.users.id)を確定
//
// 現時点ではログインUIが存在しないため、有効なtokenを送ってくる
// クライアントは実質存在しない。そのため、このヘルパーは
// 「トークンが無い/不正」な場合を例外扱いせず、常に安全に
// userId: nullへフォールバックする(=このヘルパー自体は未認証を
// 拒否しない。拒否するかどうかは呼び出し元のAPI Routeの責務であり、
// STEP131時点では「未認証でも既存Workflowを引き続き許可する」方針の
// ため、呼び出し元はnullを受け入れる)。
//
// 秘密情報(access_token本体・詳細なエラー内容)はログへ出力しない。

export interface AuthenticatedUser {
  userId: string | null;
  email: string | null;

  // Phase 31: 検証済みのaccess_token本体。core/tact-project/store.tsが
  // RLS(auth.uid()ベースの所有者チェック、Phase30)を実際に機能させる
  // ためのper-request Supabaseクライアント構築にのみ使う
  // (絶対条件: 新しい認証ユーティリティを作らず、既存の検証結果を
  // 追加でそのまま公開するだけに留める)。ログには出力しないこと
  // (既存のtoken非ログ出力方針、STEP131を維持)。
  accessToken: string | null;
}

const UNAUTHENTICATED: AuthenticatedUser = {
  userId: null,
  email: null,
  accessToken: null,
};

export async function getAuthenticatedUser(
  request: Request
): Promise<AuthenticatedUser> {

  const authHeader =
    request.headers.get("authorization") ??
    request.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return UNAUTHENTICATED;
  }

  const token =
    authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return UNAUTHENTICATED;
  }

  try {

    const { data, error } =
      await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return UNAUTHENTICATED;
    }

    return {
      userId: data.user.id,
      email: data.user.email ?? null,
      accessToken: token,
    };

  } catch {

    // token検証自体が失敗した場合(ネットワークエラー等)も、
    // 安全側として「未認証」にフォールバックする。
    // エラー詳細はtoken漏洩防止のためログに出さない。
    console.warn(
      "[Auth] Session token verification failed."
    );

    return UNAUTHENTICATED;

  }

}
