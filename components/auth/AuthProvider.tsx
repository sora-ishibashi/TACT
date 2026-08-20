"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";

import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/core/database/supabase";

// =========================
// AuthProvider (STEP132)
// =========================
//
// TACTのbrowser側でSupabase Authのsessionを保持・提供するだけの
// 最小限のProvider。core/database/supabase.ts(既存のanonキー
// クライアント)をそのまま利用し、新しいSupabaseクライアント設定は
// 作らない。
//
// 目的はSTEP131で実装済みのserver側検証(core/auth/
// getAuthenticatedUser.ts)が読む
// "Authorization: Bearer <access_token>" ヘッダーへ、ここで取得した
// session.access_tokenをそのまま渡せる状態を作ること。
//
// セキュリティ: password・access_token本体はここでもログへ出力しない。

interface AuthContextValue {

  user: User | null;

  session: Session | null;

  loading: boolean;

  signIn: (
    email: string,
    password: string
  ) => Promise<{ error: string | null }>;

  signUp: (
    email: string,
    password: string
  ) => Promise<{ error: string | null }>;

  signOut: () => Promise<void>;

  // 現在のaccess_token(未ログイン時はnull)。
  // TACT Workflow APIへのAuthorization Bearerヘッダーとして使う。
  getAccessToken: () => string | null;

}

const AuthContext =
  createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider(
  { children }: { children: ReactNode }
) {

  const [session, setSession] =
    useState<Session | null>(null);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {

    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {

        if (!mounted) return;

        setSession(data.session ?? null);

        setLoading(false);

      });

    const { data: listener } =
      supabase.auth.onAuthStateChange(
        (_event, newSession) => {

          // STEP132: signOut()時、Supabase側から
          // (_event === "SIGNED_OUT", newSession === null)が通知される。
          // ここでもsessionを明示的にnullへ更新することで、
          // 「ログアウト後のsessionを利用しない」を保証する。
          setSession(newSession);

        }
      );

    return () => {

      mounted = false;

      listener.subscription.unsubscribe();

    };

  }, []);

  async function signIn(
    email: string,
    password: string
  ): Promise<{ error: string | null }> {

    const { error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    return {
      error: error?.message ?? null,
    };

  }

  async function signUp(
    email: string,
    password: string
  ): Promise<{ error: string | null }> {

    const { error } =
      await supabase.auth.signUp({
        email,
        password,
      });

    return {
      error: error?.message ?? null,
    };

  }

  async function signOut() {

    await supabase.auth.signOut();

    // onAuthStateChangeのコールバックでもsetSession(null)されるが、
    // ネットワーク遅延なくUIへ即時反映するためここでも明示的に行う。
    setSession(null);

  }

  function getAccessToken(): string | null {

    return session?.access_token ?? null;

  }

  return (

    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        loading,
        signIn,
        signUp,
        signOut,
        getAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>

  );

}

export function useAuth(): AuthContextValue {

  const ctx =
    useContext(AuthContext);

  if (!ctx) {

    throw new Error(
      "useAuth() must be used within <AuthProvider>."
    );

  }

  return ctx;

}
