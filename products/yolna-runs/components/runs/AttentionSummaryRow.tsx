import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { attentionReviewPresentation, attentionStatusJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { ChevronRightIcon } from "@/components/icons/RunsIcons";
import { isAttentionDanger } from "@/lib/statusPresentation";
import { ExecutionIdentity } from "./ExecutionIdentity";

type AttentionSummaryRowProps = { item: AttentionCardView; variant: "compact" | "expanded"; selected?: boolean; onSelect: () => void };

function formatAttentionTime(iso: string): string {
  try { return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
}

/** The canonical action/source/status summary used by Home and the Attention list. */
export function AttentionSummaryRow({ item, variant, selected = false, onSelect }: AttentionSummaryRowProps) {
  const review = attentionReviewPresentation(item);
  return <button type="button" onClick={onSelect} aria-pressed={variant === "expanded" ? selected : undefined} className={`runs-focus block min-h-12 w-full cursor-pointer py-2.5 text-left hover:bg-runs-hover ${selected ? "bg-runs-selected" : ""}`}>
    <ExecutionIdentity provider={item.targetSystem.label} providerDetail={item.targetSystem.subLabel} action={item.action} status={item.executionStatus} workLabel={item.workTitle} time={formatAttentionTime(item.createdAt)} attention={{ classification: review.label, lifecycle: variant === "expanded" ? attentionStatusJapanese(item.status) : undefined, danger: isAttentionDanger(item.attentionReason) }} trailing={<ChevronRightIcon className="text-runs-text-secondary" />} />
  </button>;
}
