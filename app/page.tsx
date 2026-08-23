// =========================
// TACT — 既定の入口 (STEP215)
// =========================
//
// STEP215で、新TACT(Persistent Core / Research / Direct Push)を
// 通常利用経路(ルート"/")にした。旧TACT(複数Agent Legacy Workflow)
// は削除しておらず、"/legacy"(app/legacy/page.tsx)からFrozen Legacy
// として引き続きアクセスできる。

import TactShell from "@/components/tact/TactShell";

export default function Home() {

  return <TactShell />;

}
