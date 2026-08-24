"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/auth/AuthProvider";

// =========================
// /login (STEP132、Phase72でBeta Entry品質に改善)
// =========================
//
// 最小限のSign in / Sign up フォーム。デザインは作り込まず、
// TACT本体(app/page.tsx・TactInterface)のUI・レイアウト・テーマには
// 影響しない、完全に独立したページとする。
//
// Phase72 Section4/5: エラーメッセージはSupabaseの内部エラー詳細を
// そのまま出さず、ユーザーが理解できる文言へ変換する。また、Signup
// 成功=即ログイン成功とは仮定せず、AuthProvider.signUp()が返す
// sessionCreated(実際のsession状態)を見て遷移か確認メール表示かを
// 決める。

// Supabase Authの標準エラーメッセージ(英語)を、内部詳細を含まない
// 範囲でユーザーに理解できる表現へ変換する。一致しないメッセージは
// そのまま表示する(Supabaseの標準メッセージ自体が既に内部実装の詳細を
// 含まないため、フォールバックとして安全)。
function describeAuthError(raw: string): string {

  const lower = raw.toLowerCase();

  if (lower.includes("invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }

  if (lower.includes("email not confirmed")) {
    return "メールアドレスの確認が完了していません。届いた確認メール内のリンクを開いてください。";
  }

  if (lower.includes("already registered")) {
    return "このメールアドレスは既に登録されています。ログインをお試しください。";
  }

  if (lower.includes("password") && lower.includes("least")) {
    return "パスワードは6文字以上で入力してください。";
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("load failed")
  ) {
    return "通信エラーが発生しました。ネットワーク接続をご確認のうえ、もう一度お試しください。";
  }

  return raw;

}

export default function LoginPage() {

  const { user, signIn, signUp } = useAuth();

  const router = useRouter();

  const [mode, setMode] =
    useState<"signin" | "signup">("signin");

  const [email, setEmail] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [error, setError] =
    useState<string | null>(null);

  const [message, setMessage] =
    useState<string | null>(null);

  const [submitting, setSubmitting] =
    useState(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {

    event.preventDefault();

    setError(null);
    setMessage(null);
    setSubmitting(true);

    if (mode === "signin") {

      const result = await signIn(email, password);

      setSubmitting(false);

      if (result.error) {

        // STEP132: password自体はエラーメッセージに含まれないため
        // (Supabase Authの標準エラーメッセージのみ)、そのまま表示可能。
        // Phase72: ユーザーが理解できる表現へ変換してから表示する。
        setError(describeAuthError(result.error));

        return;

      }

      router.push("/");

      return;

    }

    const result = await signUp(email, password);

    setSubmitting(false);

    if (result.error) {

      setError(describeAuthError(result.error));

      return;

    }

    // Phase72 Section5: Signup成功=即ログイン成功とは仮定しない。
    // sessionCreated(Supabaseの実際のsession状態)がtrueの場合のみ
    // (Email確認が不要な設定の場合)、そのままTACTへ遷移する。
    if (result.sessionCreated) {

      router.push("/");

      return;

    }

    setMessage(
      "確認メールを送信しました。メール内のリンクを確認してください。"
    );

  }

  if (user) {

    return (
      <main style={containerStyle}>
        <p>{user.email} としてログイン済みです。</p>
        <a href="/">TACTへ戻る</a>
      </main>
    );

  }

  return (
    <main style={containerStyle}>

      <h1 style={{ fontSize: 20, marginBottom: 16 }}>
        {mode === "signin" ? "ログイン" : "サインアップ"}
      </h1>

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={submitting}
          style={inputStyle}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          disabled={submitting}
          style={inputStyle}
        />

        {error && (
          <p style={{ color: "#c0392b", fontSize: 13 }}>{error}</p>
        )}

        {message && (
          <p style={{ color: "#2e7d32", fontSize: 13 }}>{message}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={buttonStyle}
        >
          {submitting
            ? "送信中..."
            : mode === "signin"
              ? "Sign in"
              : "Sign up"}
        </button>

      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setMessage(null);
        }}
        style={linkButtonStyle}
      >
        {mode === "signin"
          ? "アカウントをお持ちでない方はこちら"
          : "既にアカウントをお持ちの方はこちら"}
      </button>

      <div style={{ marginTop: 24 }}>
        <a href="/" style={{ fontSize: 13, color: "#555" }}>
          ログインせずにTACTへ戻る
        </a>
      </div>

    </main>
  );

}

const containerStyle: React.CSSProperties = {
  maxWidth: 360,
  margin: "80px auto",
  fontFamily: "sans-serif",
  padding: "0 16px",
};

const inputStyle: React.CSSProperties = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 4,
  border: "1px solid #333",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};

const linkButtonStyle: React.CSSProperties = {
  marginTop: 12,
  background: "none",
  border: "none",
  color: "#555",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
  textAlign: "left",
};
