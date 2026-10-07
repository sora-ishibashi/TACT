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
  return <section className="border-b border-runs-border-subtle py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-xs font-semibold text-runs-text-secondary">{title}</h3>{children}</section>;
}

function DetailsButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label="AIの詳細を開く" title="AIの詳細を開く" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover hover:text-runs-text focus-visible:ring-2 focus-visible:ring-runs-focus"><DetailsIcon /></button>;
}

export function AgentManagementView(props: AgentManagementProps) {
  if (props.state) return <PresentationState kind={props.state} />;
  if (props.items.length === 0) return <PresentationState kind="empty">AI として観測できる活動・権限スコープはまだありません。</PresentationState>;
  if (!props.selectedAgentId) return <p className="text-sm text-runs-text-secondary">左の一覧からAI識別子を選択してください。</p>;
  const detail = props.details.find((item) => item.agentId === props.selectedAgentId) ?? null;
  if (!detail) return <PresentationState kind="unavailable" />;

  const hasExecutionRecord = detail.recentExecutions.length > 0;
  const hasPermissionSettings = detail.permission.ruleCount > 0;

  return <div className="flex min-w-0 max-w-5xl flex-col">
    <header className="flex items-start justify-between gap-4 border-b border-runs-border-subtle pb-4">
      <div className="min-w-0"><h1 className="break-words text-2xl font-semibold leading-8 text-runs-text">{detail.agentId}</h1><p className="mt-1 text-xs text-runs-text-secondary">最終活動: {detail.lastActivityAt ? formatDateTime(detail.lastActivityAt) : "活動は確認できません"}</p></div>
      {props.onOpenDetails && <DetailsButton onClick={props.onOpenDetails} />}
    </header>

    <section className="grid border-b border-runs-border-subtle py-4 sm:grid-cols-3">
      <div className="py-1 sm:pr-4"><p className="text-xs text-runs-muted">実行記録</p><p className="mt-1 text-sm text-runs-text">{hasExecutionRecord ? "あり" : "記録なし"}</p></div>
      <div className="border-t border-runs-border-subtle py-3 sm:border-l sm:border-t-0 sm:px-4"><p className="text-xs text-runs-muted">要確認</p><p className={`mt-1 text-sm ${detail.attentions.length > 0 ? "text-runs-warning" : "text-runs-text"}`}>{detail.attentions.length > 0 ? `${detail.attentions.length}件` : "なし"}</p></div>
      <div className="border-t border-runs-border-subtle py-3 sm:border-l sm:border-t-0 sm:pl-4"><p className="text-xs text-runs-muted">権限設定</p><p className="mt-1 text-sm text-runs-text">{hasPermissionSettings ? `${detail.permission.ruleCount}ルール` : "設定なし"}</p></div>
    </section>

    <Section title="最近の実行"><div className="mt-2 divide-y divide-runs-border-subtle">{detail.recentExecutions.length ? detail.recentExecutions.map((execution) => <button key={execution.executionId} type="button" onClick={() => props.onSelectExecution?.(execution.executionId)} className="flex w-full min-w-0 items-center gap-3 py-2 text-left outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus"><span className="min-w-0 flex-1 truncate text-sm text-runs-text">{execution.targetSystem.label} · {executionActionPresentation(execution.action)}</span><ResultBadge status={execution.executionStatus} /><PermissionBadge result={execution.permissionEvaluation} /></button>) : <p className="text-sm text-runs-text-secondary">実行記録はありません。</p>}</div></Section>
    <Section title="最近のWork"><div className="mt-2 divide-y divide-runs-border-subtle">{detail.recentWorks.length ? detail.recentWorks.map((work) => <button key={work.workId} type="button" onClick={() => props.onSelectWork?.(work.workId)} className="flex w-full items-center justify-between gap-3 py-2 text-left outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus"><span className="min-w-0 truncate text-sm text-runs-text">{work.workTitle ?? WORK_TITLE_UNCONFIRMED}</span><ResultBadge status={work.latestExecutionStatus} /></button>) : <p className="text-sm text-runs-text-secondary">Workは確認できません。</p>}</div></Section>
    <Section title="対象サービス"><div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">{detail.targetSystems.length ? detail.targetSystems.map((system) => <div key={`${system.label}-${system.subLabel ?? ""}`} className="text-sm"><span className="text-runs-text">{system.label}{system.subLabel ? ` · ${system.subLabel}` : ""}</span><span className="ml-2 text-xs text-runs-muted">{system.executionCount}件</span></div>) : <p className="text-sm text-runs-text-secondary">対象サービスは確認できません。</p>}</div></Section>
    {detail.attentions.length > 0 && <Section title="要確認"><div className="mt-2 flex flex-wrap items-center gap-2">{detail.attentions.map((attention) => <button key={attention.attentionId} type="button" onClick={() => props.onSelectExecution?.(attention.executionId)} className="outline-none focus-visible:ring-2 focus-visible:ring-runs-focus"><AttentionReasonBadge reason={attention.reason} /></button>)}{props.onOpenAttention && <button type="button" onClick={props.onOpenAttention} className="text-xs text-runs-interactive hover:underline">要確認を開く</button>}</div></Section>}
  </div>;
}

export function AgentManagementPeek({ onClose, ...props }: AgentManagementProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.agentId === props.selectedAgentId) ?? null;
  if (!detail) return null;

  const availableBasics = [detail.aiProvider ? ["AI提供元", detail.aiProvider] : null, detail.model ? ["モデル", detail.model] : null].filter((item): item is [string, string] => item !== null);

  return <DetailPeek title={`${detail.agentId} の詳細`} onClose={onClose}>
    <div className="flex min-w-0 flex-col">
      <Section title="追加情報">{availableBasics.length ? <dl className="mt-2 grid gap-1 text-xs">{availableBasics.map(([label, value]) => <div key={label}><dt className="inline text-runs-muted">{label}: </dt><dd className="inline text-runs-text">{value}</dd></div>)}</dl> : <p className="mt-2 text-sm text-runs-text-secondary">現在確認できる追加メタデータはありません。</p>}</Section>
      <Section title="識別の根拠"><ul className="mt-2 space-y-1 text-sm text-runs-text-secondary">{detail.identityEvidence.map((evidence) => <li key={evidence}>{identityEvidenceLabel(evidence)}</li>)}</ul></Section>
      <Section title="依頼元 / AIへの委任"><div className="mt-2 grid gap-3 text-xs sm:grid-cols-2"><div><p className="font-medium text-runs-text-secondary">依頼元</p>{detail.principals.length ? detail.principals.map((principal, index) => <p key={`${principal.actorKind}-${index}`} className="mt-1 text-runs-text">{principal.actorKindLabel} · {principal.actorLabel}</p>) : <p className="mt-1 text-runs-text-secondary">確認できません</p>}</div><div><p className="font-medium text-runs-text-secondary">AIへの委任</p>{detail.delegations.length ? detail.delegations.map((delegation, index) => <p key={`${delegation.onBehalfOfActorKind}-${index}`} className="mt-1 text-runs-text">{delegation.onBehalfOfActorKindLabel} · {delegation.actorLabel}</p>) : <p className="mt-1 text-runs-text-secondary">確認できません</p>}</div></div></Section>
      <Section title="接続の根拠"><div className="mt-2 space-y-2">{detail.connectionEvidence.connections.length ? detail.connectionEvidence.connections.map((connection) => <div key={connection.connectionId} className="flex justify-between gap-3 text-xs"><span className="text-runs-text">{connection.service} · {connection.provider}</span><span className="text-runs-text-secondary">{connection.statusLabel}</span></div>) : <p className="text-sm text-runs-text-secondary">{detail.connectionEvidence.unavailableMessage}</p>}</div></Section>
      <Section title="権限の詳細"><div className="mt-2 flex items-center justify-between gap-3 text-xs"><span className="text-runs-text-secondary">許可 {detail.permission.allowedCount} · 承認 {detail.permission.approvalRequiredCount} · 拒否 {detail.permission.deniedCount}</span>{props.onOpenPermission && <button type="button" onClick={() => props.onOpenPermission?.(detail.permission.exactScopeKey)} className="shrink-0 text-runs-interactive hover:underline">権限を開く</button>}</div><div className="mt-2 space-y-1">{detail.permission.rules.map((rule) => <p key={rule.ruleId} className="text-xs text-runs-text-secondary">{rule.identifier} · {rule.targetSystemLabel} · {rule.actionCategory ?? UNCONFIRMED}</p>)}</div></Section>
    </div>
  </DetailPeek>;
}
