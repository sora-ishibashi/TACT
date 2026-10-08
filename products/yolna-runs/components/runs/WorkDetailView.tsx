"use client";

import type { KeyboardEvent } from "react";
import type { WorkHeaderView, WorkTimelineItemView } from "@tact/runs-core/tact-runs-view";
import { workStatusPresentation } from "@/lib/workStatusPresentation";
import { ChevronRightIcon } from "@/components/icons/RunsIcons";
import { ExecutionIdentity } from "./ExecutionIdentity";

function formatTimestamp(iso: string): string {
  try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; }
}

export default function WorkDetailView({ work, items, onReviewCorrelation, onSelectExecution }: { work: WorkHeaderView; items: WorkTimelineItemView[]; onReviewCorrelation?: (executionId: string) => void; onSelectExecution?: (executionId: string) => void }) {
  const openExecution = (executionId: string) => onSelectExecution?.(executionId);
  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, executionId: string) => { if (!onSelectExecution || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); openExecution(executionId); };
  return <div className="flex min-w-0 flex-col gap-6">
    <header className="border-b border-runs-border-subtle pb-4"><h1 className="break-words text-2xl font-semibold leading-8 text-runs-text">{work.title ?? "名前のないWork"}</h1><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-runs-text-secondary"><span>{workStatusPresentation(work.status)}</span><span aria-hidden="true">・</span><span>実行 {work.executionCount} 件</span>{work.attentionCount !== null && <><span aria-hidden="true">・</span><span>要確認 {work.attentionCount} 件</span></>}</div></header>
    {items.length === 0 ? <p className="text-sm leading-[18px] text-runs-text-secondary">このWorkに紐づく実行記録はまだありません。</p> : <div className="min-w-0 divide-y divide-runs-border-subtle border-y border-runs-border-subtle">{items.map((item) => <article key={item.executionId} role={onSelectExecution ? "button" : undefined} tabIndex={onSelectExecution ? 0 : undefined} onClick={() => openExecution(item.executionId)} onKeyDown={(event) => onRowKeyDown(event, item.executionId)} aria-label={onSelectExecution ? `${item.targetSystem.label} ${item.action} の詳細を開く` : undefined} className={`min-w-0 px-1 py-3 outline-none transition-colors duration-150 motion-reduce:transition-none ${onSelectExecution ? "cursor-pointer hover:bg-runs-hover focus-visible:bg-runs-selected focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus" : ""} lg:px-3`}><ExecutionIdentity provider={item.targetSystem.label} providerDetail={item.targetSystem.subLabel} action={item.action} status={item.executionStatus} workLabel={work.title} time={formatTimestamp(item.observedAt)} trailing={onSelectExecution ? <ChevronRightIcon className="text-runs-text-secondary" /> : undefined} /><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-runs-text-secondary"><span title={item.agentLabel}>AI: {item.agentLabel}</span><span>依頼元: {item.principalLabel}</span>{item.correlationReasonCode ? <span>紐づけ理由: {item.correlationReasonCode}</span> : <span>紐づけ理由: 不明</span>}{item.isHumanCorrected && onReviewCorrelation ? <button type="button" onClick={(event) => { event.stopPropagation(); onReviewCorrelation(item.executionId); }} className="runs-focus rounded-sm text-xs text-runs-muted hover:text-runs-text-secondary hover:underline">履歴</button> : null}</div></article>)}</div>}
  </div>;
}
