import Header from "../components/Header";
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

        <Header />

        <TactInterface />

      </div>

    </main>
  );
}