"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { useAuth } from "@/components/auth/AuthProvider";
import { Field, TextInput, primaryButton, secondaryButton } from "@/components/ui/RunsPrimitives";

// =========================
// /login (SOR-135 Phase 2)
// =========================
//
// Minimal sign in / sign up form, adapted unchanged in logic from the root
// Yolna application's app/login/page.tsx (same AuthProvider contract, same
// Supabase project/auth — Runs and Yolna share the same user accounts,
// only the application/UI is separate). No design system work in this
// phase.

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

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {

    event.preventDefault();

    setError(null);
    setMessage(null);
    setSubmitting(true);

    if (mode === "signin") {

      const result = await signIn(email, password);

      setSubmitting(false);

      if (result.error) {
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

    if (result.sessionCreated) {
      router.push("/");
      return;
    }

    setMessage("確認メールを送信しました。メール内のリンクを確認してください。");

  }

  if (user) {

    return (
      <main className="mx-auto mt-20 max-w-sm px-4 text-sm text-runs-text">
        <p className="break-all">{user.email} としてログイン済みです。</p>
        <Link className="runs-focus mt-4 inline-flex rounded-sm font-medium text-runs-interactive hover:underline" href="/">Yolna Runsへ戻る</Link>
      </main>
    );

  }

  return (
    <main className="mx-auto mt-12 max-w-sm px-4 sm:mt-20">

      <h1 className="mb-2 text-xl font-semibold text-runs-text">
        {mode === "signin" ? "ログイン" : "サインアップ"}
      </h1>
      <p className="mb-5 text-sm leading-5 text-runs-text-secondary">Yolna Runs の実行記録と要確認項目を安全に確認します。</p>

      <form onSubmit={handleSubmit} className="grid gap-4" aria-busy={submitting}>

        <Field label="メールアドレス"><TextInput type="email" autoComplete="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={submitting} /></Field>

        <Field label="パスワード" hint={mode === "signup" ? "6文字以上で入力してください。" : undefined}><TextInput type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} disabled={submitting} /></Field>

        {error && <p role="alert" className="rounded-md bg-runs-danger-surface p-3 text-sm leading-5 text-runs-danger">{error}</p>}

        {message && <p role="status" className="rounded-md bg-runs-success-surface p-3 text-sm leading-5 text-runs-success">{message}</p>}

        <button type="submit" disabled={submitting} className={`${primaryButton} w-full`}>
          {submitting ? "送信中..." : mode === "signin" ? "Sign in" : "Sign up"}
        </button>

      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setMessage(null);
        }}
        className={`${secondaryButton} mt-3 w-full border-transparent bg-transparent text-runs-text-secondary`}
      >
        {mode === "signin" ? "アカウントをお持ちでない方はこちら" : "既にアカウントをお持ちの方はこちら"}
      </button>

    </main>
  );

}
