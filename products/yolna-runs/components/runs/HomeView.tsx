import type { ActivityItemView, AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import type { WorkListItem } from "./WorkSidebar";
import { AttentionIndicator, StatusIndicator } from "./StatusIndicator";
import { ChevronRightIcon } from "@/components/icons/RunsIcons";
import { AttentionSummaryRow } from "./AttentionSummaryRow";
import { ExecutionIdentity } from "./ExecutionIdentity";

function time(value: string | null): string { return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "時刻不明"; }

type HomeViewProps = {
  attention: AttentionCardView[]; attentionState: PresentationStateKind | null;
  works: WorkListItem[]; worksState: PresentationStateKind | null;
  activity: ActivityItemView[]; activityState: PresentationStateKind | null;
  activityStatusSummary: { failed: number; running: number; succeeded: number };
  onSelectWork: (id: string) => void; onOpenAttention: () => void; onSelectAttention: (id: string) => void;
  onOpenActivity: (status?: "failed" | "running" | "succeeded") => void;
  onSelectExecution: (id: string) => void;
};

function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <div className="flex items-baseline justify-between gap-3 pb-2"><h2 className="text-base font-semibold text-runs-text">{title}</h2>{action && onAction ? <button type="button" onClick={onAction} className="runs-focus inline-flex shrink-0 items-center gap-1 text-xs font-medium text-runs-interactive hover:underline">{action}<ChevronRightIcon /></button> : null}</div>;
}

export function HomeView({ attention, attentionState, works, worksState, activity, activityState, activityStatusSummary, onSelectWork, onOpenAttention, onSelectAttention, onOpenActivity, onSelectExecution }: HomeViewProps) {
  return <div className="flex max-w-6xl flex-col gap-6">
    <h1 className="sr-only">ホーム</h1>
    <div aria-label="現在の状態の要約" className="grid overflow-hidden rounded-lg border border-runs-border-subtle bg-runs-surface sm:grid-cols-2 lg:grid-cols-4">
      <button type="button" onClick={onOpenAttention} className="runs-focus flex min-h-20 flex-col justify-center border-b border-runs-border-subtle px-4 text-left hover:bg-runs-hover sm:border-r lg:border-b-0"><AttentionIndicator label="要確認" /><strong className="mt-1 text-2xl font-semibold tabular-nums text-runs-warning">{attention.length}</strong></button>
      <button type="button" onClick={() => onOpenActivity("failed")} className="runs-focus flex min-h-20 flex-col justify-center border-b border-runs-border-subtle px-4 text-left hover:bg-runs-hover sm:border-r lg:border-b-0"><StatusIndicator status="failed" className="text-xs" /><strong className="mt-1 text-2xl font-semibold tabular-nums text-runs-danger">{activityStatusSummary.failed}</strong></button>
      <button type="button" onClick={() => onOpenActivity("running")} className="runs-focus flex min-h-20 flex-col justify-center border-b border-runs-border-subtle px-4 text-left hover:bg-runs-hover lg:border-b-0 lg:border-r"><StatusIndicator status="running" className="text-xs" /><strong className="mt-1 text-2xl font-semibold tabular-nums text-runs-interactive">{activityStatusSummary.running}</strong></button>
      <button type="button" onClick={() => onOpenActivity("succeeded")} className="runs-focus flex min-h-20 flex-col justify-center px-4 text-left hover:bg-runs-hover"><StatusIndicator status="succeeded" className="text-xs" /><strong className="mt-1 text-2xl font-semibold tabular-nums text-runs-success">{activityStatusSummary.succeeded}</strong></button>
    </div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <section className="min-w-0"><SectionHeader title="要確認" action="要確認一覧へ" onAction={onOpenAttention} /><div className="divide-y divide-runs-border-subtle rounded-lg border border-runs-border-subtle bg-runs-surface px-3">{attentionState ? <div className="py-3"><PresentationState kind={attentionState} /></div> : attention.length === 0 ? <p className="py-3 text-sm text-runs-text-secondary">要確認の項目はありません。</p> : attention.slice(0, 3).map((item) => <AttentionSummaryRow key={item.attentionId} item={item} variant="compact" onSelect={() => onSelectAttention(item.attentionId)} />)}</div></section>
      <section className="min-w-0"><SectionHeader title="最近のWork" /><div className="divide-y divide-runs-border-subtle rounded-lg border border-runs-border-subtle bg-runs-surface px-3">{worksState ? <div className="py-3"><PresentationState kind={worksState} /></div> : works.length === 0 ? <p className="py-3 text-sm text-runs-text-secondary">表示できるWorkはありません。</p> : works.slice(0, 5).map((work) => <button key={work.workId} type="button" onClick={() => onSelectWork(work.workId)} className="runs-focus flex min-h-12 w-full cursor-pointer items-center gap-3 py-2.5 text-left hover:bg-runs-hover"><span className="min-w-0 flex-1 truncate text-sm font-medium text-runs-text" title={work.title ?? "名前のないWork"}>{work.title ?? "名前のないWork"}</span>{work.attentionCount > 0 ? <span className="text-xs text-runs-warning">要確認 {work.attentionCount}</span> : null}<span className="shrink-0 text-xs text-runs-muted">{time(work.lastActivity)}</span><ChevronRightIcon className="shrink-0 text-runs-text-secondary" /></button>)}</div></section>
    </div>
    <section className="min-w-0"><SectionHeader title="最近の実行" action="実行の一覧へ" onAction={() => onOpenActivity()} /><div className="divide-y divide-runs-border-subtle rounded-lg border border-runs-border-subtle bg-runs-surface px-3">{activityState ? <div className="py-3"><PresentationState kind={activityState} /></div> : activity.length === 0 ? <p className="py-3 text-sm text-runs-text-secondary">表示できる実行はありません。</p> : activity.slice(0, 5).map((item) => <button key={item.executionId} type="button" onClick={() => onSelectExecution(item.executionId)} className="runs-focus block min-h-12 w-full cursor-pointer py-2.5 text-left hover:bg-runs-hover"><ExecutionIdentity provider={item.targetSystem.label} providerDetail={item.targetSystem.subLabel} action={item.action} status={item.executionStatus} workLabel={item.workTitle} time={time(item.observedAt)} trailing={<ChevronRightIcon className="text-runs-text-secondary" />} /></button>)}</div></section>
  </div>;
}
