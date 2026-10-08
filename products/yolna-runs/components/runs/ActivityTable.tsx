"use client";

import type { KeyboardEvent } from "react";
import type { ActivityItemView, AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { attentionReviewPresentation } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { ChevronRightIcon, WarningIcon } from "@/components/icons/RunsIcons";
import { ExecutionIdentity } from "./ExecutionIdentity";

function formatTimestamp(iso: string): string {
  try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; }
}

function ActivityWork({ item, onSelectWork, onReviewCorrelation }: { item: ActivityItemView; onSelectWork: (workId: string) => void; onReviewCorrelation?: (executionId: string) => void }) {
  if (item.correlationStatus === "CORRELATED" && item.workId) return <div className="min-w-0"><button type="button" title={item.workTitle ?? "Work名は未観測"} onClick={(event) => { event.stopPropagation(); onSelectWork(item.workId!); }} className="runs-focus block max-w-full truncate rounded-sm text-xs font-medium text-runs-interactive hover:underline">{item.workTitle ?? "Work名は未観測"}</button>{item.isHumanCorrected && onReviewCorrelation ? <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="runs-focus mt-0.5 rounded-sm text-xs text-runs-muted hover:text-runs-text-secondary hover:underline">履歴</button> : null}</div>;
  const label = item.correlationStatus === "AMBIGUOUS" ? "Workの紐づけを確認" : "Work未割り当て";
  if (onReviewCorrelation) return <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="inline-flex items-center gap-1 text-xs text-runs-text-secondary hover:text-runs-interactive hover:underline"><WarningIcon />{label}</button>;
  return <span className="inline-flex items-center gap-1 text-xs text-runs-muted"><WarningIcon />{label}</span>;
}

export default function ActivityTable({ items, onSelectWork, onReviewCorrelation, onSelectExecution, attentionItems = [], selectedExecutionId }: { items: ActivityItemView[]; onSelectWork: (workId: string) => void; onSelectExecution: (executionId: string) => void; attentionItems?: AttentionCardView[]; selectedExecutionId: string | null; onReviewCorrelation?: (executionId: string) => void }) {
  if (items.length === 0) return <p className="text-sm leading-[18px] text-runs-text-secondary">まだ記録された実行はありません。</p>;
  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, executionId: string) => { if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); onSelectExecution(executionId); };
  return <div className="min-w-0 divide-y divide-runs-border-subtle border-y border-runs-border-subtle">
    {items.map((item) => {
      const attention = attentionItems.find((candidate) => candidate.executionId === item.executionId);
      return <article key={item.executionId} role="button" tabIndex={0} onClick={() => onSelectExecution(item.executionId)} onKeyDown={(event) => onRowKeyDown(event, item.executionId)} aria-label={`${item.targetSystem.label} ${item.action} の詳細を開く`} className={`min-w-0 cursor-pointer px-1 py-3 outline-none transition hover:bg-runs-hover focus-visible:bg-runs-selected focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus lg:px-3 ${item.executionId === selectedExecutionId ? "bg-runs-selected" : ""}`}>
        <ExecutionIdentity provider={item.targetSystem.label} providerDetail={item.targetSystem.subLabel} action={item.action} status={item.executionStatus} workLabel={item.workTitle} time={formatTimestamp(item.observedAt)} trailing={<ChevronRightIcon className="text-runs-text-secondary" />} />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-0 text-xs text-runs-text-secondary"><ActivityWork item={item} onSelectWork={onSelectWork} onReviewCorrelation={onReviewCorrelation} />{attention ? <span className="inline-flex items-center gap-1 text-runs-warning"><WarningIcon />{attentionReviewPresentation(attention).label}</span> : null}<span title={item.agentLabel}>AI: {item.agentLabel}</span><span>依頼元: {item.principalLabel}</span></div>
      </article>;
    })}
  </div>;
}
