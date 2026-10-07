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
    return <div className="min-w-0"><button type="button" title={item.workTitle ?? "Work名を確認できません"} onClick={(event) => { event.stopPropagation(); onSelectWork(item.workId!); }} className="runs-focus block max-w-full truncate rounded-sm text-xs font-medium text-runs-interactive hover:underline">{item.workTitle ?? "Work名を確認できません"}</button>{item.isHumanCorrected && onReviewCorrelation && <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="runs-focus mt-0.5 rounded-sm text-xs text-runs-muted hover:text-runs-text-secondary hover:underline">履歴</button>}</div>;
  }

  if (onReviewCorrelation) return <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="inline-flex items-center gap-1 text-xs text-runs-text-secondary hover:text-runs-interactive hover:underline"><WarningIcon />判断が必要</button>;
  return <span className="inline-flex items-center gap-1 text-xs text-runs-muted"><WarningIcon />判断が必要</span>;
}

export default function ActivityTable({ items, onSelectWork, onReviewCorrelation, onSelectExecution, attentionExecutionIds = new Set<string>(), selectedExecutionId }: {
  items: ActivityItemView[];
  onSelectWork: (workId: string) => void;
  onSelectExecution: (executionId: string) => void;
  attentionExecutionIds?: ReadonlySet<string>;
  selectedExecutionId: string | null;
  onReviewCorrelation?: (executionId: string) => void;
}) {
  if (items.length === 0) return <p className="text-sm leading-[18px] text-runs-text-secondary">まだ記録された実行はありません。</p>;

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, executionId: string) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelectExecution(executionId);
  };

  return <div className="min-w-0 divide-y divide-runs-border-subtle border-y border-runs-border-subtle">
    {items.map((item) => {
      const needsAttention = attentionExecutionIds.has(item.executionId);
      return <article key={item.executionId} role="button" tabIndex={0} onClick={() => onSelectExecution(item.executionId)} onKeyDown={(event) => onRowKeyDown(event, item.executionId)} aria-label={`${item.targetSystem.label} ${executionActionPresentation(item.action)} の詳細を開く`} className={`grid min-w-0 cursor-pointer gap-x-4 gap-y-2 px-1 py-3 outline-none transition hover:bg-runs-hover focus-visible:bg-runs-selected focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(100px,.7fr)_auto] lg:items-center lg:gap-y-1 lg:px-3 ${item.executionId === selectedExecutionId ? "bg-runs-selected" : ""}`}>
        <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><ResultBadge status={item.executionStatus} />{needsAttention && <AttentionIndicator label="要確認" />}</div><p className="mt-1 truncate text-sm font-medium text-runs-text" title={`${item.targetSystem.label} ・ ${executionActionPresentation(item.action)}`}>{item.targetSystem.label}{item.targetSystem.subLabel && <span className="ml-1 text-xs font-normal text-runs-muted">{item.targetSystem.subLabel}</span>} ・ {executionActionPresentation(item.action)}</p></div>
        <ActivityWork item={item} onSelectWork={onSelectWork} onReviewCorrelation={onReviewCorrelation} />
        <p className="truncate text-xs text-runs-text-secondary" title={item.agentLabel}>{item.agentLabel}</p>
        <div className="flex items-center justify-between gap-3 lg:justify-end"><time className="whitespace-nowrap text-xs text-runs-text-secondary">{formatTimestamp(item.observedAt)}</time><ChevronRightIcon className="text-runs-text-secondary" /></div>
      </article>;
    })}
  </div>;
}
