import type { ComponentType } from "react";
import type { ExecutionStatus } from "@tact/runs-core/tact-execution/types";
import {
  CancelledIcon,
  CheckCircleIcon,
  ObservedIcon,
  RunningIcon,
  type RunsIconProps,
  UnknownIcon,
  WarningIcon,
  XCircleIcon,
} from "@/components/icons/RunsIcons";
export { summarizeActivityStatuses } from "@/lib/statusPresentation";

export type StatusPresentation = { label: string; icon: ComponentType<RunsIconProps>; className: string };

export const EXECUTION_STATUS_PRESENTATION: Record<ExecutionStatus, StatusPresentation> = {
  succeeded: { label: "完了", icon: CheckCircleIcon, className: "text-[#16835D]" },
  failed: { label: "失敗", icon: XCircleIcon, className: "text-[#C53F4B]" },
  running: { label: "実行中", icon: RunningIcon, className: "text-[#2563B8]" },
  observed: { label: "観測済み", icon: ObservedIcon, className: "text-[#64748B]" },
  cancelled: { label: "取り消し", icon: CancelledIcon, className: "text-[#737373]" },
  unknown: { label: "判定できません", icon: UnknownIcon, className: "text-[#737373]" },
};

export function StatusIndicator({ status, className = "" }: { status: ExecutionStatus; className?: string }) {
  const presentation = EXECUTION_STATUS_PRESENTATION[status];
  const StatusIcon = presentation.icon;
  return <span className={`inline-flex items-center gap-1.5 ${presentation.className} ${className}`} title={presentation.label}><StatusIcon className="shrink-0" /><span className="sr-only">状態: </span><span>{presentation.label}</span></span>;
}

export function AttentionIndicator({ danger = false, label }: { danger?: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1.5 ${danger ? "text-[#C53F4B]" : "text-[#B7791F]"}`} title={label}><WarningIcon className="shrink-0" /><span className="sr-only">要確認: </span><span>{label}</span></span>;
}
