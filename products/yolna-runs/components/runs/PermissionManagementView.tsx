"use client";

import type { ReactNode } from "react";
import type { PermissionScopeView } from "@tact/runs-core/tact-runs-view/permissionManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { PermissionBadge, ResultBadge } from "./badges";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

type PermissionManagementProps = { scopes: PermissionScopeView[]; state: PresentationStateKind | null; selectedScopeKey: string | null; onSelectExecution?: (executionId: string) => void; onSelectWork?: (workId: string) => void };

export function PermissionManagementView({ scopes, state }: Pick<PermissionManagementProps, "scopes" | "state">) {
  if (state) return <PresentationState kind={state} />;
  if (scopes.length === 0) return <PresentationState kind="empty" />;
  return <p className="text-[13px] text-[#626161]">左の一覧から AI と対象システムの組み合わせを選択すると詳細を確認できます。</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#D9D9D9] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[13px] font-medium text-[#112278]">{title}</h3>{children}</section>;
}

export function PermissionManagementPeek({ onClose, ...props }: PermissionManagementProps & { onClose: () => void }) {
  if (props.state) return null;
  const scope = props.scopes.find((item) => item.scopeKey === props.selectedScopeKey) ?? null;
  if (!scope) return null;

  return <DetailPeek title="権限の詳細" onClose={onClose}>
    <div className="flex min-w-0 flex-col px-5 py-4">
      <header className="pb-4"><p className="text-[16px] font-medium text-[#112278]">{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</p>{scope.hasConflict && <p className="mt-1 text-[12px] font-medium text-[#C53F4B]">登録済み権限と下流の観測結果に差異があります。</p>}</header>
      <Section title="Runs に登録された権限"><div className="mt-2 space-y-2">{scope.registeredRules.length ? scope.registeredRules.map((rule) => <div key={rule.id} className="text-[12px]"><p className="text-[#112278]">{rule.identifier} · {rule.decisionLabel}</p><p className="text-[#626161]">{rule.actionCategory ?? "種別未確認"} · {rule.resourceType ?? "リソース未確認"} · {rule.enabled ? "有効" : "無効"} · v{rule.revision}</p></div>) : <p className="text-[13px] text-[#626161]">登録済みのルールはありません。</p>}</div></Section>
      <Section title="下流の証跡"><div className="mt-2 space-y-2">{scope.downstreamEvidence.length ? scope.downstreamEvidence.map((evidence) => <div key={evidence.evidenceId} className="flex items-start justify-between gap-3 text-[12px]"><div><p className="text-[#112278]">{evidence.provider} · {evidence.permissionStateLabel}</p><p className={evidence.relationToRuns === "CONFLICT" ? "text-[#C53F4B]" : "text-[#626161]"}>{evidence.authorityLevelLabel} · {evidence.trustLevelLabel} · {evidence.relationToRunsLabel}</p></div><button type="button" onClick={() => props.onSelectExecution?.(evidence.executionId)} className="shrink-0 text-[#172E95] hover:underline">実行を開く</button></div>) : <p className="text-[13px] text-[#626161]">下流の証跡は確認できません。</p>}</div></Section>
      <Section title="実際に行われた操作"><div className="mt-2 space-y-2">{scope.actualActions.length ? scope.actualActions.map((action) => <div key={action.executionId} className="flex items-start gap-2 text-[12px]"><div className="min-w-0 flex-1"><button type="button" onClick={() => props.onSelectExecution?.(action.executionId)} className="truncate text-left text-[#172E95] hover:underline">{action.targetSystem.label} · {action.action}</button><p className="text-[#626161]">{action.principalLabel} · {formatDateTime(action.observedAt)}</p>{action.workId && <button type="button" onClick={() => props.onSelectWork?.(action.workId!)} className="text-[#172E95] hover:underline">Work を開く</button>}</div><div className="flex shrink-0 gap-1"><ResultBadge status={action.executionStatus} /><PermissionBadge result={action.permissionEvaluation} /></div></div>) : <p className="text-[13px] text-[#626161]">実行の証跡はありません。</p>}</div></Section>
    </div>
  </DetailPeek>;
}
