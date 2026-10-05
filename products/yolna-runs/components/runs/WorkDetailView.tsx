"use client";

import type { KeyboardEvent } from "react";
import type { WorkHeaderView, WorkTimelineItemView } from "@tact/runs-core/tact-runs-view";
import { ResultBadge } from "./badges";
import { executionActionPresentation } from "@/lib/executionInspector";
import { workStatusPresentation } from "@/lib/workStatusPresentation";
import { ChevronRightIcon } from "@/components/icons/RunsIcons";

function formatTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

export default function WorkDetailView({ work, items, onReviewCorrelation, onSelectExecution }: {
  work: WorkHeaderView;
  items: WorkTimelineItemView[];
  onReviewCorrelation?: (executionId: string) => void;
  onSelectExecution?: (executionId: string) => void;
}) {
  const openExecution = (executionId: string) => onSelectExecution?.(executionId);
  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, executionId: string) => {
    if (!onSelectExecution || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openExecution(executionId);
  };

  return <div className="flex min-w-0 flex-col gap-5">
    <header className="border-b border-[#E5E5E5] pb-4"><h1 className="text-[22px] font-semibold leading-8 text-[#171717]">{work.title ?? "名前のないWork"}</h1><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#626161]"><span>{workStatusPresentation(work.status)}</span><span aria-hidden="true">・</span><span>実行 {work.executionCount} 件</span>{work.attentionCount !== null && <><span aria-hidden="true">・</span><span>要確認 {work.attentionCount} 件</span></>}</div></header>
    {items.length === 0 ? <p className="text-[13px] leading-[18px] text-[#626161]">このWorkに紐づく実行記録はまだありません。</p> : <div className="min-w-0 divide-y divide-[#E5E5E5] border-y border-[#E5E5E5]">{items.map((item) => <article key={item.executionId} role={onSelectExecution ? "button" : undefined} tabIndex={onSelectExecution ? 0 : undefined} onClick={() => openExecution(item.executionId)} onKeyDown={(event) => onRowKeyDown(event, item.executionId)} aria-label={onSelectExecution ? `${item.targetSystem.label} ${executionActionPresentation(item.action)} の詳細を開く` : undefined} className={`grid min-w-0 gap-x-4 gap-y-2 px-1 py-3 outline-none transition ${onSelectExecution ? "cursor-pointer hover:bg-[#FAFAFA] focus-visible:bg-[#F7F8FC] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6]" : ""} lg:grid-cols-[minmax(0,1.6fr)_minmax(100px,.7fr)_auto] lg:items-center lg:gap-y-1 lg:px-3`}><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><ResultBadge status={item.executionStatus} />{item.isHumanCorrected && onReviewCorrelation && <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="text-[10px] text-[#8A8A8A] hover:text-[#626161] hover:underline">履歴</button>}</div><p className="mt-1 truncate text-[13px] font-medium text-[#171717]">{item.targetSystem.label}{item.targetSystem.subLabel && <span className="ml-1 text-[11px] font-normal text-[#8A8A8A]">{item.targetSystem.subLabel}</span>} ・ {executionActionPresentation(item.action)}</p></div><p className="truncate text-[12px] text-[#626161]">{item.agentLabel}</p><div className="flex items-center justify-between gap-3 lg:justify-end"><time className="whitespace-nowrap text-[12px] text-[#626161]">{formatTimestamp(item.observedAt)}</time>{onSelectExecution && <ChevronRightIcon className="text-[#626161]" />}</div></article>)}</div>}
  </div>;
}
