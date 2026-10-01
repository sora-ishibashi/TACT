"use client";

// =========================
// WorkDetailView (SOR-54 Screen 3: Work Detail / Work Timeline)
// =========================
//
// 絶対条件(SOR-53/54指示「Important architecture rule」): 別のTimeline
// ledgerを作らない。ここで描画するitemsは、呼び出し元がGET
// /api/tact/runs/work/[workId](listExecutionsForWork()、既存SOR-50)
// から取得した「Canonical Execution Ledgerをwork_idでfilterした結果」
// そのもの——AMBIGUOUS/UNASSIGNEDのExecutionはこのlistに構造的に
// 含まれない。
//
// SOR-23 (OBS-UX-P1 Priority 2): 「なぜこのExecutionはこのWorkへ割り
// 当てられたか」(correlationMethodLabel/correlationConfidence/
// correlationReasonCode、SOR-77が既に持つcorrelation historyから導出)
// と、人間が訂正したrowに対するHistory導線(SOR-77 CorrelationReview
// Modalの再利用、correction UXの再実装はしない)を追加した。

import type { WorkHeaderView, WorkTimelineItemView } from "@tact/runs-core/tact-runs-view";
import { PermissionBadge, ResultBadge } from "./badges";

function formatTimestamp(iso: string): string {

  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }

}

function formatConfidence(confidence: number | null): string | null {

  if (confidence === null) {
    return null;
  }

  return `${Math.round(confidence * 100)}%`;

}

export default function WorkDetailView({
  work,
  items,
  onBack,
  onReviewCorrelation,
}: {
  work: WorkHeaderView;
  items: WorkTimelineItemView[];
  onBack: () => void;
  // SOR-23(加算的prop): 省略時は既存どおりHistory actionを出さない
  // (RunsSectionが既にActivityへ渡しているのと同じ関数をそのまま渡す
  // だけ——判定・永続化ロジックはここに一切無い)。
  onReviewCorrelation?: (executionId: string) => void;
}) {

  return (

    // SOR-23 compact-width fix: this root is a flex item of RunsSection's
    // "selectedWorkId" wrapper (flex flex-col, already min-w-0 on itself) —
    // this div, one level further in, needs its own min-w-0 too, or the
    // 880px table below still forces it (and everything above it) wider
    // than the viewport instead of scrolling within its own container.
    <div className="flex min-w-0 flex-col gap-4">

      <button
        type="button"
        onClick={onBack}
        className="w-fit text-[12px] text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
      >
        ← Back
      </button>

      <div className="flex flex-col gap-1">

        <h2 className="text-[24px] font-medium leading-[32px] text-[#112278]">
          {work.title ?? work.workId}
        </h2>

        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#626161]">
          {/* SOR-23 Priority 1: Work titleが主表示になった今、raw UUIDは
              secondary/debug情報として残す(navigationは変更しない)。 */}
          <span title="Work ID">{work.workId}</span>
          <span aria-hidden="true">・</span>
          <span>{work.statusLabel}</span>
          <span aria-hidden="true">・</span>
          <span>{work.executionCount} execution{work.executionCount === 1 ? "" : "s"}</span>
          {work.attentionCount !== null && (
            <>
              <span aria-hidden="true">・</span>
              <span>{work.attentionCount} open attention{work.attentionCount === 1 ? "" : "s"}</span>
            </>
          )}
        </div>

      </div>

      {items.length === 0 ? (

        <p className="text-[13px] leading-[18px] text-[#626161]">
          このWorkに紐づくExecutionはまだありません。
        </p>

      ) : (

        <div className="min-w-0 overflow-x-auto rounded-xl border border-[#D9D9D9]">

          <table className="w-full min-w-[880px] border-collapse text-left text-[13px] leading-[18px] text-[#112278]">

            <thead>
              <tr className="border-b border-[#D9D9D9] bg-[#F2F2F2]/60 text-[12px] font-medium text-[#626161]">
                <th scope="col" className="px-4 py-2.5">Time</th>
                <th scope="col" className="px-4 py-2.5">Principal</th>
                <th scope="col" className="px-4 py-2.5">Agent</th>
                <th scope="col" className="px-4 py-2.5">SaaS</th>
                <th scope="col" className="px-4 py-2.5">Action</th>
                <th scope="col" className="px-4 py-2.5">Permission</th>
                <th scope="col" className="px-4 py-2.5">Result</th>
                <th scope="col" className="px-4 py-2.5">Outcome</th>
                <th scope="col" className="px-4 py-2.5">Why this Work</th>
              </tr>
            </thead>

            <tbody>
              {items.map((item) => (

                <tr key={item.executionId} className="border-b border-[#D9D9D9] last:border-b-0 hover:bg-[#E6F2F2]/40">

                  <td className="whitespace-nowrap px-4 py-2.5 text-[#626161]">{formatTimestamp(item.observedAt)}</td>
                  <td className="px-4 py-2.5">{item.principalLabel}</td>
                  <td className="px-4 py-2.5">{item.agentLabel}</td>
                  <td className="px-4 py-2.5">
                    <span>{item.targetSystem.label}</span>
                    {item.targetSystem.subLabel && (
                      <span className="ml-1 text-[10px] text-[#8A8A8A]">{item.targetSystem.subLabel}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium">{item.action}</td>
                  <td className="px-4 py-2.5"><PermissionBadge result={item.permissionEvaluation} /></td>
                  <td className="px-4 py-2.5"><ResultBadge status={item.executionStatus} /></td>
                  <td className="px-4 py-2.5">
                    {/* SOR-119: Execution status(技術的成否、左のResult列)とは
                        別に、「結局何が変わったか」を表示する。
                        outcomeKind=nullはoutcomeStatus="unknown"を意味し、
                        これは正常な状態(絶対条件)——エラー表示ではなく、
                        Disabled文字色(#8A8A8A、docs/ui-design-rules.md)で
                        中立的に示す。値の再計算・推測はここでも行わない。 */}
                    {item.outcomeKind ? (
                      <span className="text-[12px] text-[#112278]">{item.outcomeKind}</span>
                    ) : (
                      <span className="text-[12px] text-[#8A8A8A]">Unknown</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <span className="text-[12px] text-[#112278]">{item.correlationMethodLabel ?? "—"}</span>
                        {formatConfidence(item.correlationConfidence) !== null && (
                          <span className="text-[10px] text-[#8A8A8A]">{formatConfidence(item.correlationConfidence)} confidence</span>
                        )}
                      </div>
                      {item.isHumanCorrected && onReviewCorrelation && (
                        <button
                          type="button"
                          onClick={() => onReviewCorrelation(item.executionId)}
                          className="shrink-0 text-[12px] text-[#626161] underline-offset-2 transition duration-150 ease-out hover:text-[#112278] hover:underline"
                        >
                          History
                        </button>
                      )}
                    </div>
                  </td>

                </tr>

              ))}
            </tbody>

          </table>

        </div>

      )}

    </div>

  );

}
