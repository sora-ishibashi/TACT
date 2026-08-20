import TactInterface from "../components/TactInterface";
import { supabase } from "@/core/database/supabase";

export default async function Home() {

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