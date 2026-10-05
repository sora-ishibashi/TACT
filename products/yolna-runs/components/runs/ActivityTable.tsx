"use client";

import type { KeyboardEvent } from "react";
import type { ActivityItemView } from "@tact/runs-core/tact-runs-view";
import { ResultBadge } from "./badges";
import { AttentionIndicator } from "./StatusIndicator";
import { executionActionPresentation } from "@/lib/executionInspector";
import { ChevronRightIcon, WarningIcon } from "@/components/icons/RunsIcons";

function formatTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

function ActivityWork({ item, onSelectWork, onReviewCorrelation }: { item: ActivityItemView; onSelectWork: (workId: string) => void; onReviewCorrelation?: (executionId: string) => void }) {
  if (item.correlationStatus === "CORRELATED" && item.workId) {
    return <div className="min-w-0"><button type="button" onClick={(event) => { event.stopPropagation(); onSelectWork(item.workId!); }} className="block max-w-full truncate text-[12px] font-medium text-[#172E95] hover:underline">{item.workTitle ?? "Work名を確認できません"}</button>{item.isHumanCorrected && onReviewCorrelation && <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="mt-0.5 text-[10px] text-[#8A8A8A] hover:text-[#626161] hover:underline">履歴</button>}</div>;
  }

  if (onReviewCorrelation) return <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="inline-flex items-center gap-1 text-[11px] text-[#626161] hover:text-[#172E95] hover:underline"><WarningIcon />判断が必要</button>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-[#8A8A8A]"><WarningIcon />判断が必要</span>;
}

export default function ActivityTable({ items, onSelectWork, onReviewCorrelation, onSelectExecution, attentionExecutionIds = new Set<string>(), selectedExecutionId }: {
  items: ActivityItemView[];
  onSelectWork: (workId: string) => void;
  onSelectExecution: (executionId: string) => void;
  attentionExecutionIds?: ReadonlySet<string>;
  selectedExecutionId: string | null;
  onReviewCorrelation?: (executionId: string) => void;
}) {
  if (items.length === 0) return <p className="text-[13px] leading-[18px] text-[#626161]">まだ記録された実行はありません。</p>;

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, executionId: string) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelectExecution(executionId);
  };

  return <div className="min-w-0 divide-y divide-[#E5E5E5] border-y border-[#E5E5E5]">
    {items.map((item) => {
      const needsAttention = attentionExecutionIds.has(item.executionId);
      return <article key={item.executionId} role="button" tabIndex={0} onClick={() => onSelectExecution(item.executionId)} onKeyDown={(event) => onRowKeyDown(event, item.executionId)} aria-label={`${item.targetSystem.label} ${executionActionPresentation(item.action)} の詳細を開く`} className={`grid min-w-0 cursor-pointer gap-x-4 gap-y-2 px-1 py-3 outline-none transition hover:bg-[#FAFAFA] focus-visible:bg-[#F7F8FC] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(100px,.7fr)_auto] lg:items-center lg:gap-y-1 lg:px-3 ${item.executionId === selectedExecutionId ? "bg-[#E6F2F2]" : ""}`}>
        <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><ResultBadge status={item.executionStatus} />{needsAttention && <AttentionIndicator label="要確認" />}</div><p className="mt-1 truncate text-[13px] font-medium text-[#171717]">{item.targetSystem.label}{item.targetSystem.subLabel && <span className="ml-1 text-[11px] font-normal text-[#8A8A8A]">{item.targetSystem.subLabel}</span>} ・ {executionActionPresentation(item.action)}</p></div>
        <ActivityWork item={item} onSelectWork={onSelectWork} onReviewCorrelation={onReviewCorrelation} />
        <p className="truncate text-[12px] text-[#626161]">{item.agentLabel}</p>
        <div className="flex items-center justify-between gap-3 lg:justify-end"><time className="whitespace-nowrap text-[12px] text-[#626161]">{formatTimestamp(item.observedAt)}</time><ChevronRightIcon className="text-[#626161]" /></div>
      </article>;
    })}
  </div>;
}
