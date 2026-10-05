"use client";

import type { ReactNode } from "react";
import type { AgentManagementDetailView, AgentManagementItemView } from "@tact/runs-core/tact-runs-view/agentManagement";
import { identityEvidenceLabel } from "@tact/runs-core/tact-runs-view/agentManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { executionActionPresentation } from "@/lib/executionInspector";
import { AttentionReasonBadge, PermissionBadge, ResultBadge } from "./badges";

const UNCONFIRMED = "確認できません";
const WORK_TITLE_UNCONFIRMED = "仕事のタイトルを確認できません";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : UNCONFIRMED;
}

type AgentManagementProps = {
  items: AgentManagementItemView[];
  details: AgentManagementDetailView[];
  state: PresentationStateKind | null;
  selectedAgentId: string | null;
  onSelectWork?: (workId: string) => void;
  onSelectExecution?: (executionId: string) => void;
  onOpenPermission?: (exactScopeKey: string | null) => void;
  onOpenAttention?: () => void;
};

export function AgentManagementView({ items, state }: Pick<AgentManagementProps, "items" | "state">) {
  if (state) return <PresentationState kind={state} />;
  if (items.length === 0) return <PresentationState kind="empty">AI として観測できる活動・権限スコープはまだありません。</PresentationState>;
  return <p className="text-[13px] text-[#626161]">左の一覧から AI 識別子を選択すると詳細を確認できます。</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#D9D9D9] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[13px] font-medium text-[#112278]">{title}</h3>{children}</section>;
}

export function AgentManagementPeek({ onClose, ...props }: AgentManagementProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.agentId === props.selectedAgentId) ?? null;
  if (!detail) return null;

  return <DetailPeek title="AI の詳細" onClose={onClose}>
    <div className="flex min-w-0 flex-col px-5 py-4">
      <header className="pb-4"><p className="break-words text-[16px] font-medium text-[#112278]">{detail.agentId}</p><p className="mt-1 text-[12px] text-[#626161]">最終活動: {detail.lastActivityAt ? formatDateTime(detail.lastActivityAt) : "活動は確認できません"}</p></header>
      <Section title="基本情報"><dl className="mt-2 grid gap-1 text-[12px]"><div><dt className="inline text-[#8A8A8A]">表示名: </dt><dd className="inline text-[#112278]">{UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">AI提供元: </dt><dd className="inline text-[#112278]">{UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">モデル: </dt><dd className="inline text-[#112278]">{UNCONFIRMED}</dd></div><div><dt className="inline text-[#8A8A8A]">登録状態: </dt><dd className="inline text-[#112278]">{UNCONFIRMED}</dd></div></dl></Section>
      <Section title="識別の根拠"><ul className="mt-2 space-y-1 text-[13px] text-[#626161]">{detail.identityEvidence.map((evidence) => <li key={evidence}>{identityEvidenceLabel(evidence)}</li>)}</ul></Section>
      <Section title="依頼元 / AIへの委任"><div className="mt-2 grid gap-3 text-[12px] sm:grid-cols-2"><div><p className="font-medium text-[#626161]">依頼元</p>{detail.principals.length ? detail.principals.map((principal, index) => <p key={`${principal.actorKind}-${index}`} className="mt-1 text-[#112278]">{principal.actorKindLabel} · {principal.actorLabel}</p>) : <p className="mt-1 text-[#626161]">確認できません</p>}</div><div><p className="font-medium text-[#626161]">AIへの委任</p>{detail.delegations.length ? detail.delegations.map((delegation, index) => <p key={`${delegation.onBehalfOfActorKind}-${index}`} className="mt-1 text-[#112278]">{delegation.onBehalfOfActorKindLabel} · {delegation.actorLabel}</p>) : <p className="mt-1 text-[#626161]">確認できません</p>}</div></div></Section>
      <Section title="対象システム"><div className="mt-2 space-y-2">{detail.targetSystems.length ? detail.targetSystems.map((system) => <div key={system.label} className="flex gap-3 text-[12px]"><span className="min-w-0 flex-1 text-[#112278]">{system.label}{system.subLabel ? ` · ${system.subLabel}` : ""}</span><span className="shrink-0 text-[#626161]">{system.executionCount} 件 · {formatDateTime(system.lastObservedAt)}</span></div>) : <p className="text-[13px] text-[#626161]">対象システムは確認できません。</p>}</div></Section>
      <Section title="接続の根拠"><div className="mt-2 space-y-2">{detail.connectionEvidence.connections.length ? detail.connectionEvidence.connections.map((connection) => <div key={connection.connectionId} className="flex justify-between gap-3 text-[12px]"><span className="text-[#112278]">{connection.service} · {connection.provider}</span><span className="text-[#626161]">{connection.statusLabel}</span></div>) : <p className="text-[13px] text-[#626161]">{detail.connectionEvidence.unavailableMessage}</p>}</div></Section>
      <Section title="権限"><div className="mt-2 flex items-center justify-between gap-3 text-[12px]"><span className="text-[#626161]">{detail.permission.ruleCount} ルール · 許可 {detail.permission.allowedCount} · 承認 {detail.permission.approvalRequiredCount} · 拒否 {detail.permission.deniedCount}</span>{props.onOpenPermission && <button type="button" onClick={() => props.onOpenPermission?.(detail.permission.exactScopeKey)} className="shrink-0 text-[#172E95] hover:underline">権限を開く</button>}</div><div className="mt-2 space-y-1">{detail.permission.rules.map((rule) => <p key={rule.ruleId} className="text-[12px] text-[#626161]">{rule.identifier} · {rule.targetSystemLabel} · {rule.actionCategory ?? UNCONFIRMED}</p>)}</div></Section>
      <Section title="最近の仕事"><div className="mt-2 space-y-2">{detail.recentWorks.length ? detail.recentWorks.map((work) => <div key={work.workId} className="flex items-center justify-between gap-3 text-[12px]"><button type="button" onClick={() => props.onSelectWork?.(work.workId)} className="min-w-0 truncate text-left text-[#172E95] hover:underline">{work.workTitle ?? WORK_TITLE_UNCONFIRMED}</button><ResultBadge status={work.latestExecutionStatus} /></div>) : <p className="text-[13px] text-[#626161]">仕事は確認できません。</p>}</div></Section>
      <Section title="最近の実行"><div className="mt-2 space-y-2">{detail.recentExecutions.length ? detail.recentExecutions.map((execution) => <div key={execution.executionId} className="flex items-center gap-2 text-[12px]"><button type="button" onClick={() => props.onSelectExecution?.(execution.executionId)} className="min-w-0 flex-1 truncate text-left text-[#172E95] hover:underline">{execution.targetSystem.label} · {executionActionPresentation(execution.action)}</button><ResultBadge status={execution.executionStatus} /><PermissionBadge result={execution.permissionEvaluation} /></div>) : <p className="text-[13px] text-[#626161]">実行は確認できません。</p>}</div></Section>
      <Section title="要確認"><div className="mt-2 space-y-2">{detail.attentions.length ? detail.attentions.map((attention) => <button key={attention.attentionId} type="button" onClick={() => props.onSelectExecution?.(attention.executionId)} className="block text-left"><AttentionReasonBadge reason={attention.reason} /></button>) : <p className="text-[13px] text-[#626161]">有効な要確認はありません。</p>}{props.onOpenAttention && detail.attentions.length > 0 && <button type="button" onClick={props.onOpenAttention} className="text-[12px] text-[#172E95] hover:underline">要確認を開く</button>}</div></Section>
    </div>
  </DetailPeek>;
}
