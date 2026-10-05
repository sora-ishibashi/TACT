"use client";

import { useState } from "react";
import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { actionJapanese, attentionPrimaryAction, attentionPrimaryActionJapanese, attentionReasonJapanese, attentionReasonJapaneseExplanation, attentionStatusJapanese, executionResultJapanese, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { AttentionIndicator } from "./StatusIndicator";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { isAttentionDanger } from "@/lib/statusPresentation";

function formatTimestamp(iso: string): string { try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } }

function AttentionDetail({ item, onClose, onSelectWork, onSelectExecution, onOpenPermissionSettings, onTransition }: { item: AttentionCardView; onClose: () => void; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const primaryAction = attentionPrimaryAction(item);
  const primaryLabel = attentionPrimaryActionJapanese(primaryAction);
  return <DetailPeek title="要確認の詳細" onClose={onClose} footer={primaryAction && primaryLabel ? <button type="button" onClick={() => onTransition(item.attentionId, primaryAction)} className="w-full rounded bg-[#172E95] px-4 py-2 text-[13px] font-medium text-white hover:bg-[#112278]">{primaryLabel}</button> : undefined}>
    <div className="flex items-center gap-2"><AttentionIndicator danger={isAttentionDanger(item.attentionReason)} label={attentionReasonJapanese(item.attentionReason)} /><span className="text-[12px] text-[#626161]">{attentionStatusJapanese(item.status)}</span></div>
    <h3 className="mt-4 text-[16px] font-semibold text-[#171717]">対応が必要です</h3><p className="mt-1 text-[13px] leading-5 text-[#626161]">{attentionReasonJapaneseExplanation(item.attentionReason)}</p>
    <dl className="mt-5 grid gap-y-4 text-[13px]"><div><dt className="text-[#8A8A8A]">対象</dt><dd className="mt-0.5 text-[#171717]">{item.targetSystem.label} で {actionJapanese(item.action)}</dd></div><div><dt className="text-[#8A8A8A]">実行の結果</dt><dd className="mt-0.5 text-[#171717]">{executionResultJapanese(item.executionStatus)}</dd></div><div><dt className="text-[#8A8A8A]">AI</dt><dd className="mt-0.5 text-[#171717]">{item.agentLabel}</dd></div><div><dt className="text-[#8A8A8A]">依頼元</dt><dd className="mt-0.5 text-[#171717]">{item.principalLabel}</dd></div><div><dt className="text-[#8A8A8A]">権限</dt><dd className="mt-0.5 text-[#171717]">{permissionJapanese(item.permissionEvaluation)}</dd></div><div><dt className="text-[#8A8A8A]">確認日時</dt><dd className="mt-0.5 text-[#171717]">{formatTimestamp(item.createdAt)}</dd></div></dl>
    <div className="mt-6 flex flex-col items-start gap-3 text-[13px]">{item.workId && <button type="button" onClick={() => { onSelectWork(item.workId!); onClose(); }} className="text-[#172E95] hover:underline">仕事を開く</button>}{onOpenPermissionSettings && <button type="button" onClick={() => { onOpenPermissionSettings(); onClose(); }} className="text-[#172E95] hover:underline">権限設定を開く</button>}{onSelectExecution && <button type="button" onClick={() => { onSelectExecution(item.executionId); onClose(); }} className="text-[#172E95] hover:underline">実行の詳細を開く</button>}</div>
  </DetailPeek>;
}

export default function AttentionInbox(props: { items: AttentionCardView[]; onSelectWork: (workId: string) => void; onSelectExecution?: (executionId: string) => void; onOpenPermissionSettings?: () => void; onTransition: (id: string, action: "acknowledge" | "resolve") => void }) {
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  const selectedItem = props.items.find((item) => item.attentionId === selectedAttentionId) ?? null;
  if (props.items.length === 0) return <p className="text-[13px] text-[#626161]">対応が必要な実行記録はありません。</p>;
  return <><div className="min-w-0 divide-y divide-[#E5E5E5] border-y border-[#E5E5E5]">{props.items.map((item) => <button key={item.attentionId} type="button" onClick={() => setSelectedAttentionId(item.attentionId)} aria-pressed={item.attentionId === selectedAttentionId} className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-1 py-3 text-left transition hover:bg-[#FAFAFA] focus-visible:bg-[#F7F8FC] focus-visible:outline-2 focus-visible:outline-[#172E95] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_110px_auto] lg:items-center lg:px-3 ${item.attentionId === selectedAttentionId ? "bg-[#F7F8FC]" : ""}`}><div className="min-w-0"><AttentionIndicator danger={isAttentionDanger(item.attentionReason)} label={attentionReasonJapanese(item.attentionReason)} /><p className="mt-1 truncate text-[13px] font-medium text-[#171717]">{item.targetSystem.label} ・ {actionJapanese(item.action)}</p></div><p className="truncate text-[12px] text-[#626161]">{item.workTitle ?? "関連する仕事なし"} ・ {item.agentLabel}</p><p className="text-[12px] text-[#626161]">{attentionStatusJapanese(item.status)}</p><time className="whitespace-nowrap text-[12px] text-[#626161]">{formatTimestamp(item.createdAt)}</time></button>)}</div>{selectedItem && <AttentionDetail item={selectedItem} onClose={() => setSelectedAttentionId(null)} onSelectWork={props.onSelectWork} onSelectExecution={props.onSelectExecution} onOpenPermissionSettings={props.onOpenPermissionSettings} onTransition={props.onTransition} />}</>;
}
