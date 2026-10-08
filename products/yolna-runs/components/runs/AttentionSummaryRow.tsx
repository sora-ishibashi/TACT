import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { attentionReasonJapanese, attentionReviewPresentation, attentionStatusJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { ChevronRightIcon } from "@/components/icons/RunsIcons";

type AttentionSummaryRowProps = { item: AttentionCardView; variant: "compact" | "expanded"; selected?: boolean; onSelect: () => void };

function formatAttentionTime(iso: string): string {
  try { return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
}

/** The canonical action-first summary used by Home and the Attention list. */
export function AttentionSummaryRow({ item, variant, selected = false, onSelect }: AttentionSummaryRowProps) {
  const review = attentionReviewPresentation(item);
  const workContext = item.workTitle ?? "Work未割り当て";
  const secondary = `${attentionReasonJapanese(item.attentionReason)} · ${workContext}`;
  return <button type="button" onClick={onSelect} aria-pressed={variant === "expanded" ? selected : undefined} className={`runs-focus grid min-h-12 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 text-left hover:bg-runs-hover ${selected ? "bg-runs-selected" : ""}`}>
    <span className="min-w-0"><span className="block truncate text-sm font-medium text-runs-text">{review.heading}</span><span className="mt-1 block truncate text-xs text-runs-text-secondary">{secondary}</span></span>
    <span className="flex shrink-0 items-center gap-2 text-xs text-runs-muted">{variant === "expanded" ? <span>{attentionStatusJapanese(item.status)}</span> : null}<time>{formatAttentionTime(item.createdAt)}</time><ChevronRightIcon className="text-runs-text-secondary" /></span>
  </button>;
}
