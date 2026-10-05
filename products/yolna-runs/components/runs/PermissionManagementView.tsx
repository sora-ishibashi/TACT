"use client";

import type { ReactNode } from "react";
import type { PermissionScopeView } from "@tact/runs-core/tact-runs-view/permissionManagement";
import { DetailsIcon, WarningIcon } from "@/components/icons/RunsIcons";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { executionActionPresentation } from "@/lib/executionInspector";
import { PermissionBadge, ResultBadge } from "./badges";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

type PermissionManagementProps = {
  scopes: PermissionScopeView[];
  state: PresentationStateKind | null;
  selectedScopeKey: string | null;
  onOpenDetails?: () => void;
  onSelectExecution?: (executionId: string) => void;
  onSelectWork?: (workId: string) => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#E5E5E5] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[12px] font-semibold text-[#626161]">{title}</h3>{children}</section>;
}

export function PermissionManagementView(props: PermissionManagementProps) {
  if (props.state) return <PresentationState kind={props.state} />;
  if (props.scopes.length === 0) return <PresentationState kind="empty" />;
  if (!props.selectedScopeKey) return <p className="text-[13px] text-[#626161]">左の一覧からAIとサービスを選択してください。</p>;
  const scope = props.scopes.find((item) => item.scopeKey === props.selectedScopeKey) ?? null;
  if (!scope) return <PresentationState kind="unavailable" />;

  const enabledRules = scope.registeredRules.filter((rule) => rule.enabled);
  const decisionSummary = [...new Set(enabledRules.map((rule) => rule.decisionLabel))];

  return <div className="flex min-w-0 max-w-5xl flex-col">
    <header className="flex items-start justify-between gap-4 border-b border-[#E5E5E5] pb-4">
      <div className="min-w-0"><h1 className="break-words text-[22px] font-semibold leading-8 text-[#171717]">{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</h1>{scope.hasConflict ? <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-[#B7791F]"><WarningIcon />接続先で観測された権限とRunsの登録内容に差分があります。</p> : <p className="mt-1 text-[12px] text-[#626161]">確認が必要な権限差分はありません。</p>}</div>
      {props.onOpenDetails && <button type="button" onClick={props.onOpenDetails} aria-label="権限の技術詳細を開く" title="権限の技術詳細を開く" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#626161] outline-none hover:bg-[#F7F7F7] hover:text-[#171717] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><DetailsIcon /></button>}
    </header>

    <Section title="Runsに登録された権限"><div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="text-[15px] font-semibold text-[#171717]">{enabledRules.length}ルール</span><span className="text-[12px] text-[#626161]">{decisionSummary.length > 0 ? decisionSummary.join(" / ") : "有効な登録ルールはありません"}</span></div></Section>
    <Section title="接続先で観測された権限"><div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className={`text-[15px] font-semibold ${scope.hasConflict ? "text-[#B7791F]" : "text-[#171717]"}`}>{scope.downstreamEvidence.length}件</span><span className="text-[12px] text-[#626161]">{scope.downstreamEvidence.length === 0 ? "下流の証跡は確認できません" : scope.hasConflict ? "Runsの登録内容との不一致あり" : "記録された差分なし"}</span></div></Section>
    <Section title="最近の実際の操作"><div className="mt-2 divide-y divide-[#E5E5E5]">{scope.actualActions.length ? scope.actualActions.slice(0, 5).map((action) => <div key={action.executionId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12px]"><button type="button" onClick={() => props.onSelectExecution?.(action.executionId)} className="min-w-0 flex-1 truncate text-left text-[13px] text-[#172E95] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#18B5A6]">{action.targetSystem.label} · {executionActionPresentation(action.action)}</button><ResultBadge status={action.executionStatus} /><PermissionBadge result={action.permissionEvaluation} /><p className="basis-full text-[#626161]">{action.principalLabel} · {formatDateTime(action.observedAt)}</p>{action.workId && <button type="button" onClick={() => props.onSelectWork?.(action.workId!)} className="basis-full text-left text-[#172E95] hover:underline">Workを開く</button>}</div>) : <p className="text-[13px] text-[#626161]">実行の証跡はありません。</p>}</div></Section>
  </div>;
}

export function PermissionManagementPeek({ onClose, ...props }: PermissionManagementProps & { onClose: () => void }) {
  if (props.state) return null;
  const scope = props.scopes.find((item) => item.scopeKey === props.selectedScopeKey) ?? null;
  if (!scope) return null;

  return <DetailPeek title={`${scope.agentDisplayLabel} / ${scope.serviceDisplayLabel} の詳細`} onClose={onClose}>
    <div className="flex min-w-0 flex-col">
      <Section title="Runsに登録された権限"><div className="mt-2 space-y-3">{scope.registeredRules.length ? scope.registeredRules.map((rule) => <div key={rule.id} className="text-[12px]"><p className="break-words text-[#171717]">{rule.identifier} · {rule.decisionLabel}</p><p className="mt-0.5 text-[#626161]">{rule.actionCategory ?? "種別未確認"} · {rule.resourceType ?? "リソース未確認"} · {rule.enabled ? "有効" : "無効"} · revision {rule.revision}</p></div>) : <p className="text-[13px] text-[#626161]">登録済みのルールはありません。</p>}</div></Section>
      <Section title="接続先で観測された権限"><div className="mt-2 space-y-3">{scope.downstreamEvidence.length ? scope.downstreamEvidence.map((evidence) => <div key={evidence.evidenceId} className="text-[12px]"><div className="flex items-start justify-between gap-3"><div><p className="text-[#171717]">{evidence.provider} · {evidence.permissionStateLabel}</p><p className={evidence.relationToRuns === "CONFLICT" ? "text-[#B7791F]" : "text-[#626161]"}>{evidence.authorityLevelLabel} · {evidence.trustLevelLabel} · {evidence.relationToRunsLabel}</p></div><button type="button" onClick={() => props.onSelectExecution?.(evidence.executionId)} className="shrink-0 text-[#172E95] hover:underline">実行を開く</button></div><p className="mt-1 text-[#8A8A8A]">観測: {formatDateTime(evidence.observedAt)}</p></div>) : <p className="text-[13px] text-[#626161]">下流の証跡は確認できません。</p>}</div></Section>
    </div>
  </DetailPeek>;
}
