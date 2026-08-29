"use client";

import { ExternalLink, Link } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ArtifactEvidenceSource = {
  id: string;
  title?: string;
  url?: string;
};

const POPOVER_MARGIN = 8;

type Rect = { top: number; left: number; right: number; bottom: number };
type Size = { width: number; height: number };

/**
 * Pure viewport-collision math for the popover panel: prefers opening above and
 * left-aligned with the trigger, but flips to whichever side actually has room so the
 * panel never renders off-screen. Kept side-effect-free so it is unit-testable without a DOM.
 */
export function computePopoverPosition(
  trigger: Rect,
  panel: Size,
  viewport: Size,
  margin: number = POPOVER_MARGIN,
): { top: number; left: number; placement: "top" | "bottom" } {
  let left = trigger.left;
  if (left + panel.width + margin > viewport.width) {
    left = trigger.right - panel.width;
  }
  left = Math.max(margin, Math.min(left, viewport.width - panel.width - margin));

  const spaceAbove = trigger.top;
  const spaceBelow = viewport.height - trigger.bottom;
  const placement: "top" | "bottom" = spaceAbove >= panel.height + margin || spaceAbove >= spaceBelow ? "top" : "bottom";
  const top = placement === "top" ? trigger.top - margin - panel.height : trigger.bottom + margin;
  const clampedTop = Math.max(margin, Math.min(top, viewport.height - panel.height - margin));

  return { top: clampedTop, left, placement };
}

function getSafeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function getDomain(value: string | undefined): string | undefined {
  const safeUrl = getSafeExternalUrl(value);
  if (!safeUrl) return undefined;

  try {
    return new URL(safeUrl).hostname;
  } catch {
    return undefined;
  }
}

/** Resolves only metadata already attached to the referenced source IDs. */
export function selectArtifactEvidenceSources(
  sourceEvidenceIds: readonly string[] | undefined,
  evidenceSources: Readonly<Record<string, ArtifactEvidenceSource>>,
): ArtifactEvidenceSource[] {
  const seen = new Set<string>();
  const seenSources = new Set<string>();
  const sources: ArtifactEvidenceSource[] = [];

  for (const id of sourceEvidenceIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);

    const source = evidenceSources[id];
    if (!source || (!source.title && !getSafeExternalUrl(source.url))) continue;
    const sourceKey = getSafeExternalUrl(source.url) ?? source.title?.trim() ?? id;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    sources.push(source);
  }

  return sources;
}

export function ArtifactEvidencePopover({
  sourceEvidenceIds,
  evidenceSources,
  compact = false,
}: {
  sourceEvidenceIds?: readonly string[];
  evidenceSources: Readonly<Record<string, ArtifactEvidenceSource>>;
  compact?: boolean;
}) {
  const sources = selectArtifactEvidenceSources(sourceEvidenceIds, evidenceSources);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Positioned via a portal (not `absolute` inside the trigger) so the panel can
  // escape ancestor `overflow-hidden`/`overflow-auto` panes (Artifact pane, table
  // scroll containers, etc.) instead of being clipped by them, and is re-measured
  // against the live trigger/panel size so it always fits inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const panelWidth = panelRef.current?.offsetWidth ?? 288;
      const panelHeight = panelRef.current?.offsetHeight ?? 0;

      setPosition(computePopoverPosition(triggerRect, { width: panelWidth, height: panelHeight }, {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, sources.length]);

  if (sources.length === 0) return null;

  return (
    <div className="inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className={compact
          ? "inline-flex items-center gap-1 text-[11px] text-[#286B9A] underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
          : "inline-flex items-center gap-1 rounded-md border border-[#D9D9D9] bg-white px-2 py-1 text-[11px] text-[#286B9A] transition hover:border-[#18B5A6] hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"}
      >
        <Link aria-hidden="true" size={13} strokeWidth={2} />
        根拠を確認
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          id={popoverId}
          role="dialog"
          aria-label="根拠の出典"
          style={{
            position: "fixed",
            top: position?.top ?? -9999,
            left: position?.left ?? -9999,
            visibility: position ? "visible" : "hidden",
          }}
          className="z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-[#D9D9D9] bg-white p-3 shadow-lg"
        >
          <p className="mb-2 text-xs font-medium text-[#112278]">出典</p>
          <ul className="max-h-56 space-y-2 overflow-y-auto">
            {sources.map((source) => {
              const safeUrl = getSafeExternalUrl(source.url);
              const domain = getDomain(source.url);
              return (
                <li key={source.id} className="min-w-0 rounded-md bg-[#F7FAFA] p-2 text-xs text-[#626161]">
                  {source.title && <p className="break-words font-medium leading-5 text-[#112278]">{source.title}</p>}
                  {domain && <p className="mt-0.5 truncate" title={safeUrl}>{domain}</p>}
                  {safeUrl && (
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-[#286B9A] underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
                    >
                      <span className="truncate">元のページを開く</span>
                      <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
