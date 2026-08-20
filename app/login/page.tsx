"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/auth/AuthProvider";

// =========================
// /login (STEP132)
// =========================
//
// 最小限のSign in / Sign up フォーム。デザインは作り込まず、
// TACT本体(app/page.tsx・TactInterface)のUI・レイアウト・テーマには
// 影響しない、完全に独立したページとする。

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

    const result =
      mode === "signin"
        ? await signIn(email, password)
        : await signUp(email, password);

    setSubmitting(false);

    if (result.error) {

      // STEP132: password自体はエラーメッセージに含まれないため
      // (Supabase Authの標準エラーメッセージのみ)、そのまま表示可能。
      setError(result.error);

      return;

    }

    if (mode === "signup") {

      setMessage(
        "サインアップしました。確認メールの設定によっては、メール内リンクの確認が必要な場合があります。"
      );

      return;

    }

    router.push("/");

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
          style={inputStyle}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
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
          {mode === "signin" ? "Sign in" : "Sign up"}
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
