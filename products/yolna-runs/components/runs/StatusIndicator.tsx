import type { ExecutionStatus } from "@tact/runs-core/tact-execution/types";
export { summarizeActivityStatuses } from "@/lib/statusPresentation";

export type StatusPresentation = { label: string; symbol: string; className: string };

export const EXECUTION_STATUS_PRESENTATION: Record<ExecutionStatus, StatusPresentation> = {
  succeeded: { label: "完了", symbol: "✓", className: "text-[#16835D]" },
  failed: { label: "失敗", symbol: "×", className: "text-[#C53F4B]" },
  running: { label: "実行中", symbol: "●", className: "text-[#2563B8]" },
  observed: { label: "観測済み", symbol: "○", className: "text-[#64748B]" },
  cancelled: { label: "取り消し", symbol: "⊘", className: "text-[#737373]" },
  unknown: { label: "判定できません", symbol: "?", className: "text-[#737373]" },
};

export function StatusIndicator({ status, className = "" }: { status: ExecutionStatus; className?: string }) {
  const presentation = EXECUTION_STATUS_PRESENTATION[status];
  return <span className={`inline-flex items-center gap-1.5 ${presentation.className} ${className}`} title={presentation.label}><span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center text-[14px] font-semibold leading-none">{presentation.symbol}</span><span className="sr-only">状態: </span><span>{presentation.label}</span></span>;
}

export function AttentionIndicator({ danger = false, label }: { danger?: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1.5 ${danger ? "text-[#C53F4B]" : "text-[#B7791F]"}`} title={label}><span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold">!</span><span className="sr-only">要確認: </span><span>{label}</span></span>;
}
