"use client";

import type { ReactNode } from "react";
import type { AgentManagementDetailView, AgentManagementItemView } from "@tact/runs-core/tact-runs-view/agentManagement";
import { identityEvidenceLabel } from "@tact/runs-core/tact-runs-view/agentManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { DetailsIcon } from "@/components/icons/RunsIcons";
import { executionActionPresentation } from "@/lib/executionInspector";
import { AttentionReasonBadge, PermissionBadge, ResultBadge } from "./badges";

const UNCONFIRMED = "確認できません";
const WORK_TITLE_UNCONFIRMED = "Work名を確認できません";
const registrationStatusLabel: Record<AgentManagementDetailView["registrationStatus"], string> = { unknown: UNCONFIRMED };

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : UNCONFIRMED;
}

type AgentManagementProps = {
  items: AgentManagementItemView[];
  details: AgentManagementDetailView[];
  state: PresentationStateKind | null;
  selectedAgentId: string | null;
  onOpenDetails?: () => void;
  onSelectWork?: (workId: string) => void;
  onSelectExecution?: (executionId: string) => void;
  onOpenPermission?: (exactScopeKey: string | null) => void;
  onOpenAttention?: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#E5E5E5] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[12px] font-semibold text-[#626161]">{title}</h3>{children}</section>;
}

function DetailsButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label="AIの詳細を開く" title="AIの詳細を開く" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#626161] outline-none hover:bg-[#F7F7F7] hover:text-[#171717] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><DetailsIcon /></button>;
}

export function AgentManagementView(props: AgentManagementProps) {
  if (props.state) return <PresentationState kind={props.state} />;
  if (props.items.length === 0) return <PresentationState kind="empty">AI として観測できる活動・権限スコープはまだありません。</PresentationState>;
  if (!props.selectedAgentId) return <p className="text-[13px] text-[#626161]">左の一覧からAI識別子を選択してください。</p>;
  const detail = props.details.find((item) => item.agentId === props.selectedAgentId) ?? null;
  if (!detail) return <PresentationState kind="unavailable" />;

  const hasExecutionRecord = detail.recentExecutions.length > 0;
  const hasPermissionSettings = detail.permission.ruleCount > 0;

  return <div className="flex min-w-0 max-w-5xl flex-col">
    <header className="flex items-start justify-between gap-4 border-b border-[#E5E5E5] pb-4">
      <div className="min-w-0"><h1 className="break-words text-[22px] font-semibold leading-8 text-[#171717]">{detail.agentId}</h1><p className="mt-1 text-[12px] text-[#626161]">最終活動: {detail.lastActivityAt ? formatDateTime(detail.lastActivityAt) : "活動は確認できません"}</p></div>
      {props.onOpenDetails && <DetailsButton onClick={props.onOpenDetails} />}
    </header>

    <section className="grid border-b border-[#E5E5E5] py-4 sm:grid-cols-3">
      <div className="py-1 sm:pr-4"><p className="text-[11px] text-[#8A8A8A]">実行記録</p><p className="mt-1 text-[13px] text-[#171717]">{hasExecutionRecord ? "あり" : "記録なし"}</p></div>
      <div className="border-t border-[#E5E5E5] py-3 sm:border-l sm:border-t-0 sm:px-4"><p className="text-[11px] text-[#8A8A8A]">要確認</p><p className={`mt-1 text-[13px] ${detail.attentions.length > 0 ? "text-[#B7791F]" : "text-[#171717]"}`}>{detail.attentions.length > 0 ? `${detail.attentions.length}件` : "なし"}</p></div>
      <div className="border-t border-[#E5E5E5] py-3 sm:border-l sm:border-t-0 sm:pl-4"><p className="text-[11px] text-[#8A8A8A]">権限設定</p><p className="mt-1 text-[13px] text-[#171717]">{hasPermissionSettings ? `${detail.permission.ruleCount}ルール` : "設定なし"}</p></div>
    </section>

    <Section title="最近の実行"><div className="mt-2 divide-y divide-[#E5E5E5]">{detail.recentExecutions.length ? detail.recentExecutions.map((execution) => <button key={execution.executionId} type="button" onClick={() => props.onSelectExecution?.(execution.executionId)} className="flex w-full min-w-0 items-center gap-3 py-2 text-left outline-none hover:bg-[#FAFAFA] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6]"><span className="min-w-0 flex-1 truncate text-[13px] text-[#171717]">{execution.targetSystem.label} · {executionActionPresentation(execution.action)}</span><ResultBadge status={execution.executionStatus} /><PermissionBadge result={execution.permissionEvaluation} /></button>) : <p className="text-[13px] text-[#626161]">実行記録はありません。</p>}</div></Section>
    <Section title="最近のWork"><div className="mt-2 divide-y divide-[#E5E5E5]">{detail.recentWorks.length ? detail.recentWorks.map((work) => <button key={work.workId} type="button" onClick={() => props.onSelectWork?.(work.workId)} className="flex w-full items-center justify-between gap-3 py-2 text-left outline-none hover:bg-[#FAFAFA] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6]"><span className="min-w-0 truncate text-[13px] text-[#171717]">{work.workTitle ?? WORK_TITLE_UNCONFIRMED}</span><ResultBadge status={work.latestExecutionStatus} /></button>) : <p className="text-[13px] text-[#626161]">Workは確認できません。</p>}</div></Section>
    <Section title="対象サービス"><div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">{detail.targetSystems.length ? detail.targetSystems.map((system) => <div key={`${system.label}-${system.subLabel ?? ""}`} className="text-[13px]"><span className="text-[#171717]">{system.label}{system.subLabel ? ` · ${system.subLabel}` : ""}</span><span className="ml-2 text-[11px] text-[#8A8A8A]">{system.executionCount}件</span></div>) : <p className="text-[13px] text-[#626161]">対象サービスは確認できません。</p>}</div></Section>
    {detail.attentions.length > 0 && <Section title="要確認"><div className="mt-2 flex flex-wrap items-center gap-2">{detail.attentions.map((attention) => <button key={attention.attentionId} type="button" onClick={() => props.onSelectExecution?.(attention.executionId)} className="outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><AttentionReasonBadge reason={attention.reason} /></button>)}{props.onOpenAttention && <button type="button" onClick={props.onOpenAttention} className="text-[12px] text-[#172E95] hover:underline">要確認を開く</button>}</div></Section>}
  </div>;
}

export function AgentManagementPeek({ onClose, ...props }: AgentManagementProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.agentId === props.selectedAgentId) ?? null;
  if (!detail) return null;

  const unavailableBasics = detail.aiProvider === null && detail.model === null;

  return <DetailPeek title={`${detail.agentId} の詳細`} onClose={onClose}>
    <div className="flex min-w-0 flex-col">
      <Section title="追加情報"><dl className="mt-2 grid gap-1 text-[12px]"><div><dt className="inline text-[#8A8A8A]">表示名: </dt><dd className="inline text-[#171717]">{UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">AI提供元: </dt><dd className="inline text-[#171717]">{detail.aiProvider ?? UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">モデル: </dt><dd className="inline text-[#171717]">{detail.model ?? UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">登録状態: </dt><dd className="inline text-[#171717]">{registrationStatusLabel[detail.registrationStatus]}</dd></div></dl>{unavailableBasics && <p className="mt-2 text-[12px] text-[#626161]">追加のAI情報は確認できません。</p>}</Section>
      <Section title="識別の根拠"><ul className="mt-2 space-y-1 text-[13px] text-[#626161]">{detail.identityEvidence.map((evidence) => <li key={evidence}>{identityEvidenceLabel(evidence)}</li>)}</ul></Section>
      <Section title="依頼元 / AIへの委任"><div className="mt-2 grid gap-3 text-[12px] sm:grid-cols-2"><div><p className="font-medium text-[#626161]">依頼元</p>{detail.principals.length ? detail.principals.map((principal, index) => <p key={`${principal.actorKind}-${index}`} className="mt-1 text-[#171717]">{principal.actorKindLabel} · {principal.actorLabel}</p>) : <p className="mt-1 text-[#626161]">確認できません</p>}</div><div><p className="font-medium text-[#626161]">AIへの委任</p>{detail.delegations.length ? detail.delegations.map((delegation, index) => <p key={`${delegation.onBehalfOfActorKind}-${index}`} className="mt-1 text-[#171717]">{delegation.onBehalfOfActorKindLabel} · {delegation.actorLabel}</p>) : <p className="mt-1 text-[#626161]">確認できません</p>}</div></div></Section>
      <Section title="接続の根拠"><div className="mt-2 space-y-2">{detail.connectionEvidence.connections.length ? detail.connectionEvidence.connections.map((connection) => <div key={connection.connectionId} className="flex justify-between gap-3 text-[12px]"><span className="text-[#171717]">{connection.service} · {connection.provider}</span><span className="text-[#626161]">{connection.statusLabel}</span></div>) : <p className="text-[13px] text-[#626161]">{detail.connectionEvidence.unavailableMessage}</p>}</div></Section>
      <Section title="権限の詳細"><div className="mt-2 flex items-center justify-between gap-3 text-[12px]"><span className="text-[#626161]">許可 {detail.permission.allowedCount} · 承認 {detail.permission.approvalRequiredCount} · 拒否 {detail.permission.deniedCount}</span>{props.onOpenPermission && <button type="button" onClick={() => props.onOpenPermission?.(detail.permission.exactScopeKey)} className="shrink-0 text-[#172E95] hover:underline">権限を開く</button>}</div><div className="mt-2 space-y-1">{detail.permission.rules.map((rule) => <p key={rule.ruleId} className="text-[12px] text-[#626161]">{rule.identifier} · {rule.targetSystemLabel} · {rule.actionCategory ?? UNCONFIRMED}</p>)}</div></Section>
    </div>
  </DetailPeek>;
}
