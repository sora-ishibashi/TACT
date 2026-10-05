"use client";

import { useMemo, useState } from "react";
import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { actionJapanese, attentionPrimaryAction, attentionPrimaryActionJapanese, attentionReasonJapanese, attentionReasonJapaneseExplanation, attentionStatusJapanese, executionResultJapanese, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { AttentionIndicator } from "./StatusIndicator";
import { isAttentionDanger } from "@/lib/statusPresentation";

function formatTimestamp(iso: string): string { try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } }

function FindingRow({ item, selected, onSelect, onTransition }: { item: AttentionCardView; selected: boolean; onSelect: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const primaryAction = attentionPrimaryAction(item);
  const primaryLabel = attentionPrimaryActionJapanese(primaryAction);
  return <article className={`flex min-w-0 items-center gap-3 border-b border-[#E5E5E5] py-3 ${selected ? "bg-[#F7F8FC]" : ""}`}>
    <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" aria-pressed={selected}><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><AttentionIndicator danger={isAttentionDanger(item.attentionReason)} label={attentionReasonJapanese(item.attentionReason)} /><span className="text-[11px] text-[#626161]">{attentionStatusJapanese(item.status)}</span></div><p className="mt-1 truncate text-[13px] font-medium text-[#171717]">{item.targetSystem.label} · {actionJapanese(item.action)}</p><p className="mt-1 truncate text-[12px] text-[#626161]">{item.workTitle ?? "関連する仕事なし"} · {item.agentLabel} · {formatTimestamp(item.createdAt)}</p></button>
    {primaryAction && primaryLabel && <button type="button" onClick={() => onTransition(item.attentionId, primaryAction)} className="shrink-0 rounded bg-[#172E95] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#112278]">{primaryLabel}</button>}
  </article>;
}

function FindingDetail({ item, onSelectWork, onSelectExecution, onOpenPermissionSettings }: { item: AttentionCardView; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void }) {
  return <aside className="border-l border-[#E5E5E5] pl-4" aria-label="選択した要確認の詳細"><AttentionIndicator danger={isAttentionDanger(item.attentionReason)} label={attentionReasonJapanese(item.attentionReason)} /><h2 className="mt-3 text-[16px] font-semibold text-[#171717]">対応が必要です</h2><p className="mt-1 text-[13px] leading-5 text-[#626161]">{attentionReasonJapaneseExplanation(item.attentionReason)}</p><dl className="mt-4 grid gap-y-3 text-[13px]"><div><dt className="text-[#8A8A8A]">対象</dt><dd className="mt-0.5 text-[#171717]">{item.targetSystem.label} で {actionJapanese(item.action)}</dd></div><div><dt className="text-[#8A8A8A]">実行結果</dt><dd className="mt-0.5 text-[#171717]">{executionResultJapanese(item.executionStatus)}</dd></div><div><dt className="text-[#8A8A8A]">AI</dt><dd className="mt-0.5 text-[#171717]">{item.agentLabel}</dd></div><div><dt className="text-[#8A8A8A]">依頼元</dt><dd className="mt-0.5 text-[#171717]">{item.principalLabel}</dd></div><div><dt className="text-[#8A8A8A]">権限</dt><dd className="mt-0.5 text-[#171717]">{permissionJapanese(item.permissionEvaluation)}</dd></div><div><dt className="text-[#8A8A8A]">記録日時</dt><dd className="mt-0.5 text-[#171717]">{formatTimestamp(item.createdAt)}</dd></div></dl><div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-[12px]">{item.workId && <button type="button" onClick={() => onSelectWork(item.workId!)} className="text-[#172E95] hover:underline">仕事を開く</button>}{onOpenPermissionSettings && <button type="button" onClick={onOpenPermissionSettings} className="text-[#172E95] hover:underline">権限設定を開く</button>}{onSelectExecution && <button type="button" onClick={() => onSelectExecution(item.executionId)} className="text-[#172E95] hover:underline">実行詳細</button>}</div></aside>;
}

export default function AttentionInbox(props: { items: AttentionCardView[]; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  const selectedItem = useMemo(() => props.items.find((item) => item.attentionId === selectedAttentionId) ?? props.items[0] ?? null, [props.items, selectedAttentionId]);
  if (props.items.length === 0) return <p className="text-[13px] text-[#626161]">対応が必要な実行記録はありません。</p>;
  return <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]"><div className="min-w-0">{props.items.map((item) => <FindingRow key={item.attentionId} item={item} selected={item.attentionId === selectedItem?.attentionId} onSelect={() => setSelectedAttentionId(item.attentionId)} onTransition={props.onTransition} />)}</div>{selectedItem && <FindingDetail item={selectedItem} onSelectWork={props.onSelectWork} onSelectExecution={props.onSelectExecution} onOpenPermissionSettings={props.onOpenPermissionSettings} />}</div>;
}
