import type { ExecutionStatus } from "@tact/runs-core/tact-execution";
import type { ReactNode } from "react";
import { AttentionIndicator, StatusIndicator } from "./StatusIndicator";

type AttentionContext = {
  classification: string;
  lifecycle?: string;
  danger?: boolean;
};

type ExecutionIdentityProps = {
  provider: string;
  providerDetail?: string | null;
  action: string;
  /** List projections do not currently expose a canonical resource field. */
  objectLabel?: string | null;
  status: ExecutionStatus;
  workLabel?: string | null;
  time: string;
  attention?: AttentionContext;
  layout?: "activity" | "attention" | "compact";
  workContent?: ReactNode;
  trailing?: ReactNode;
};

export function workLabelPresentation(workLabel?: string | null): string {
  return workLabel ?? "Work未割り当て";
}

/** Shared operational-row grammar: identity, source, state, and context. */
export function ExecutionIdentity({ provider, providerDetail, action, objectLabel, status, workLabel, time, attention, layout = "compact", workContent, trailing }: ExecutionIdentityProps) {
  const object = objectLabel ?? "対象：未観測";
  const work = workLabelPresentation(workLabel);
  if (layout !== "compact") return <ExecutionIdentityColumns provider={provider} providerDetail={providerDetail} action={action} object={object} status={status} work={work} time={time} attention={attention} layout={layout} workContent={workContent} trailing={trailing} />;
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {attention ? <AttentionIndicator danger={attention.danger} label={attention.classification} /> : <StatusIndicator status={status} className="text-xs" />}
        {attention ? <StatusIndicator status={status} className="text-xs" /> : null}
      </div>
      <p className="mt-1 truncate text-sm font-medium text-runs-text" title={`${provider}${providerDetail ? ` (${providerDetail})` : ""} ・ ${action} ・ ${object}`}>
        {provider}{providerDetail ? <span className="ml-1 text-xs font-normal text-runs-muted">{providerDetail}</span> : null} ・ {action}
      </p>
      <p className="mt-1 truncate text-xs text-runs-text-secondary" title={`${object} ・ ${work}`}>
        {object} ・ {work}
      </p>
    </div>
    <div className="flex shrink-0 items-center gap-2 text-xs text-runs-muted">
      {attention?.lifecycle ? <span>{attention.lifecycle}</span> : null}
      <time>{time}</time>
      {trailing}
    </div>
  </div>;
}

function ExecutionIdentityColumns({ provider, providerDetail, action, object, status, work, time, attention, layout, workContent, trailing }: { provider: string; providerDetail?: string | null; action: string; object: string; status: ExecutionStatus; work: string; time: string; attention?: AttentionContext; layout: "activity" | "attention"; workContent?: ReactNode; trailing?: ReactNode }) {
  const attentionLayout = layout === "attention";
  const providerAction = <><p className="text-xs font-medium text-runs-muted">実行内容</p><p className="mt-1 truncate text-sm font-medium text-runs-text" title={`${provider}${providerDetail ? ` (${providerDetail})` : ""} ・ ${action}`}>{provider}{providerDetail ? <span className="ml-1 text-xs font-normal text-runs-muted">{providerDetail}</span> : null} ・ {action}</p></>;
  return <div className={`grid min-w-0 gap-x-4 gap-y-2 ${attentionLayout ? "min-[1024px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1.15fr)_minmax(0,1fr)_auto] min-[1024px]:items-center" : "min-[1024px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,.9fr)_auto] min-[1024px]:items-center"}`}>
    {attentionLayout ? <div className="min-w-0"><AttentionIndicator danger={attention?.danger} label={attention?.classification ?? "要確認"} /><div className="mt-1"><StatusIndicator status={status} className="text-xs" /></div></div> : <div className="min-w-0">{providerAction}</div>}
    {attentionLayout ? <div className="min-w-0">{providerAction}</div> : <div className="min-w-0"><p className="text-xs font-medium text-runs-muted">対象</p><p className="mt-1 truncate text-sm text-runs-text-secondary" title={object}>{object}</p></div>}
    <div className="min-w-0"><p className="text-xs font-medium text-runs-muted">{attentionLayout ? "対象・Work" : "Work"}</p>{attentionLayout ? <><p className="mt-1 truncate text-sm text-runs-text-secondary" title={object}>{object}</p><div className="mt-1 min-w-0 truncate text-xs text-runs-interactive" title={work}>{work}</div></> : workContent ?? <p className="mt-1 truncate text-sm text-runs-interactive" title={work}>{work}</p>}</div>
    <div className="min-w-0"><p className="text-xs font-medium text-runs-muted">{attentionLayout ? attention?.lifecycle ?? "状態" : "状態"}</p>{attentionLayout ? <time className="mt-1 block whitespace-nowrap text-sm text-runs-text-secondary">{time}</time> : <div className="mt-1"><StatusIndicator status={status} className="text-xs" />{attention ? <div className="mt-1"><AttentionIndicator danger={attention.danger} label={attention.classification} /></div> : null}</div>}</div>
    {!attentionLayout ? <div className="flex min-w-0 items-center justify-end gap-2 self-center text-xs text-runs-muted"><time className="whitespace-nowrap">{time}</time>{trailing}</div> : <div className="flex min-w-0 items-center justify-end gap-2 self-center text-xs text-runs-muted">{trailing}</div>}
  </div>;
}
