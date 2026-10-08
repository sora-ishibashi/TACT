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
  trailing?: ReactNode;
};

/** Shared operational-row grammar: identity, source, state, and context. */
export function ExecutionIdentity({ provider, providerDetail, action, objectLabel, status, workLabel, time, attention, trailing }: ExecutionIdentityProps) {
  const object = objectLabel ?? "対象：未観測";
  const work = workLabel ?? "Work未割り当て";
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
