import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import type { CaptureGap, ObservationSurface } from "@tact/runs-core/tact-execution";
import type { WorkListItem } from "./WorkSidebar";

function time(value: string | null): string { return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "時刻を確認できません"; }

export function HomeView({ attention, works, surfaces, gaps, onSelectWork, onOpenAttention }: { attention: AttentionCardView[]; works: WorkListItem[]; surfaces: ObservationSurface[]; gaps: CaptureGap[]; onSelectWork: (id: string) => void; onOpenAttention: () => void }) {
  const unresolved = gaps.filter((gap) => gap.status !== "RESOLVED");
  const coverageKnown = surfaces.length > 0;
  return <div className="flex max-w-4xl flex-col gap-8">
    <section><div className="flex items-baseline justify-between gap-3"><h2 className="text-[16px] font-medium text-[#112278]">あなたの対応が必要</h2><button type="button" onClick={onOpenAttention} className="text-[12px] text-[#172E95]">要確認画面へ</button></div>{attention.length === 0 ? <p className="mt-3 text-[13px] text-[#626161]">要確認の記録はありません。</p> : <div className="mt-3 flex flex-col gap-2">{attention.slice(0, 5).map((item) => <article key={item.attentionId} className="rounded-lg border border-[#D9D9D9] p-3"><p className="text-[13px] text-[#112278]">{item.attentionReasonExplanation}</p>{item.workId && <button type="button" onClick={() => onSelectWork(item.workId!)} className="mt-1 text-[12px] text-[#172E95]">{item.workTitle ?? "関連する仕事を開く"}</button>}<p className="mt-1 text-[11px] text-[#626161]">{time(item.createdAt)}</p></article>)}</div>}</section>
    <section><h2 className="text-[16px] font-medium text-[#112278]">最近の仕事</h2>{works.length === 0 ? <p className="mt-3 text-[13px] text-[#626161]">表示できる仕事の記録はありません。</p> : <div className="mt-3 grid gap-2 sm:grid-cols-2">{works.slice(0, 8).map((work) => <button key={work.workId} type="button" onClick={() => onSelectWork(work.workId)} className="rounded-lg border border-[#D9D9D9] p-3 text-left hover:bg-[#F2F2F2]"><p className="truncate text-[13px] font-medium text-[#112278]">{work.title ?? "記録なし"}</p><p className="mt-1 text-[11px] text-[#626161]">{work.lastActivity ? `最終活動 ${time(work.lastActivity)}` : "最終活動を確認できません"}</p>{work.attentionCount > 0 && <p className="mt-1 text-[11px] text-[#C53F4B]">要確認あり</p>}</button>)}</div>}</section>
    <section className="rounded-lg border border-[#D9D9D9] p-3"><h2 className="text-[14px] font-medium text-[#112278]">観測状態</h2>{!coverageKnown ? <p className="mt-1 text-[12px] text-[#626161]">観測状態を確認できません。</p> : unresolved.length > 0 ? <p className="mt-1 text-[12px] text-[#C53F4B]">この期間の一部操作を確認できていません（{unresolved.length}件）。</p> : <p className="mt-1 text-[12px] text-[#626161]">観測対象 {surfaces.length} 件に、未解決の観測欠損は記録されていません。</p>}</section>
  </div>;
}
