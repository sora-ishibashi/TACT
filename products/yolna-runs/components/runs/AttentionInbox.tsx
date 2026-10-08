"use client";

import { useState } from "react";
import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { actionJapanese, attentionPrimaryAction, attentionPrimaryActionJapanese, attentionReviewPresentation, attentionStatusJapanese, executionResultJapanese, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { AttentionIndicator } from "./StatusIndicator";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { isAttentionDanger } from "@/lib/statusPresentation";
import { AttentionSummaryRow } from "./AttentionSummaryRow";

function formatTimestamp(iso: string): string { try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } }

function AttentionDetail({ item, onClose, onSelectWork, onSelectExecution, onOpenPermissionSettings, onTransition }: { item: AttentionCardView; onClose: () => void; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const primaryAction = attentionPrimaryAction(item);
  const primaryLabel = attentionPrimaryActionJapanese(primaryAction);
  const review = attentionReviewPresentation(item);
  return <DetailPeek title="要確認の詳細" onClose={onClose} footer={primaryAction && primaryLabel ? <button type="button" onClick={() => onTransition(item.attentionId, primaryAction)} className="runs-focus w-full rounded bg-runs-interactive px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-runs-interactive-hover motion-reduce:transition-none">{primaryLabel}</button> : undefined}>
    <div className="flex items-center gap-2"><AttentionIndicator danger={isAttentionDanger(item.attentionReason)} label={review.label} /><span className="text-xs text-runs-text-secondary">{attentionStatusJapanese(item.status)}</span></div>
    <h3 className="mt-4 text-base font-semibold text-runs-text">{review.heading}</h3><p className="mt-1 text-sm leading-5 text-runs-text-secondary">{review.explanation}</p>
    <dl className="mt-5 grid gap-y-4 text-sm"><div><dt className="text-runs-muted">対象</dt><dd className="mt-0.5 text-runs-text">{item.targetSystem.label} で {actionJapanese(item.action)}</dd></div><div><dt className="text-runs-muted">実行の状態</dt><dd className="mt-0.5 text-runs-text">{executionResultJapanese(item.executionStatus)}</dd></div><div><dt className="text-runs-muted">AI</dt><dd className="mt-0.5 text-runs-text">{item.agentLabel}</dd></div><div><dt className="text-runs-muted">依頼元</dt><dd className="mt-0.5 text-runs-text">{item.principalLabel}</dd></div><div><dt className="text-runs-muted">権限評価</dt><dd className="mt-0.5 text-runs-text">{permissionJapanese(item.permissionEvaluation)}</dd></div><div><dt className="text-runs-muted">{review.timestampLabel}</dt><dd className="mt-0.5 text-runs-text">{formatTimestamp(review.timestamp)}</dd></div></dl>
    <div className="mt-6 flex flex-col items-start gap-3 text-sm">{item.workId && <button type="button" onClick={() => { onSelectWork(item.workId!); onClose(); }} className="text-runs-interactive hover:underline">Workを開く</button>}{onSelectExecution && <button type="button" onClick={() => { onSelectExecution(item.executionId); onClose(); }} className="text-runs-interactive hover:underline">実行の詳細を開く</button>}<details className="w-full border-t border-runs-border-subtle pt-3"><summary className="cursor-pointer text-xs font-semibold text-runs-text-secondary">権限・監査情報</summary><div className="mt-3">{onOpenPermissionSettings && <button type="button" onClick={() => { onOpenPermissionSettings(); onClose(); }} className="text-runs-interactive hover:underline">権限設定を開く</button>}</div></details></div>
  </DetailPeek>;
}

export default function AttentionInbox(props: { items: AttentionCardView[]; selectedAttentionId?: string | null; onSelectedAttentionChange?: (id: string | null) => void; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const [uncontrolledSelectedAttentionId, setUncontrolledSelectedAttentionId] = useState<string | null>(null);
  const selectedAttentionId = props.selectedAttentionId === undefined ? uncontrolledSelectedAttentionId : props.selectedAttentionId;
  const setSelectedAttentionId = (id: string | null) => { setUncontrolledSelectedAttentionId(id); props.onSelectedAttentionChange?.(id); };
  const selectedItem = props.items.find((item) => item.attentionId === selectedAttentionId) ?? null;
  if (props.items.length === 0) return <p className="text-sm text-runs-text-secondary">表示できる要確認項目はありません。</p>;
  return <><div className="min-w-0 divide-y divide-runs-border-subtle border-y border-runs-border-subtle">{props.items.map((item) => <AttentionSummaryRow key={item.attentionId} item={item} variant="expanded" selected={item.attentionId === selectedAttentionId} onSelect={() => setSelectedAttentionId(item.attentionId)} />)}</div>{selectedItem && <AttentionDetail item={selectedItem} onClose={() => setSelectedAttentionId(null)} onSelectWork={props.onSelectWork} onSelectExecution={props.onSelectExecution} onOpenPermissionSettings={props.onOpenPermissionSettings} onTransition={props.onTransition} />}</>;
}
