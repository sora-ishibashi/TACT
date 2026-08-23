// =========================
// LEGACY / FROZEN (STEP215)
// =========================
//
// 旧TACT UI(複数Agent Workflowによる会話)の入口。STEP215以前は
// app/page.tsx(ルート"/")がこの内容を直接描画していたが、STEP215で
// 新TACT(components/tact/TactShell.tsx)を既定の通常利用経路にした
// ため、このページへ退避した。
//
// 重要: このファイル自体・TactInterface以下の旧TACTコード
// (core/agents/*・core/planner/*・core/workflow/*・
// core/conversation/*を含む)は削除・変更していない。将来の参照・
// 復旧・比較のためのFrozen Legacyとして、"/legacy"から引き続き
// アクセスできる状態を維持する。

import TactInterface from "../../components/TactInterface";
import { supabase } from "@/core/database/supabase";

export default async function LegacyHome() {

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .limit(1);


  console.log(
    "Supabase Test:",
    data,
    error
  );


  return (
    <main className="flex h-screen bg-white">

      <div className="flex h-full w-full flex-col overflow-hidden">

        {/*
          STEP24: Headerの状態表示(🟢 Ready等)を実際のTurn実行状態
          (runStatus)と連動させるため、runStatusを保持する
          TactInterface側でHeaderをレンダリングする。
        */}

        <TactInterface />

      </div>

    </main>
  );
}
