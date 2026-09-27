"use client";

// =========================
// ActivityTable (SOR-54 Screen 1: Activity)
// =========================
//
// 全Executionのnewest-first一覧。business logic(permission判定・
// correlation判定)は一切持たない——受け取ったActivityItemView[]を
// そのまま描画するだけ(絶対条件、SOR-54指示「No business logic in
// React」)。

import type { ActivityItemView } from "@/core/tact-runs-view";
import { PermissionBadge, ResultBadge, WorkReference } from "./badges";

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

export default function ActivityTable({
  items,
  onSelectWork,
  onReviewCorrelation,
}: {
  items: ActivityItemView[];
  onSelectWork: (workId: string) => void;
  // SOR-77(加算的prop): 省略時は既存どおりReview actionを出さない。
  onReviewCorrelation?: (executionId: string) => void;
}) {

  if (items.length === 0) {

    return (
      <p className="text-[13px] leading-[18px] text-[#626161]">
        まだ観測されたExecutionはありません。
      </p>
    );

  }

  // SOR-23 compact-width fix: as a flex item of RunsSection's wrapper,
  // this scroll container itself defaults to min-width:auto — without
  // min-w-0 it refuses to shrink below the 880px table's width, so its
  // own overflow-x-auto never gets the chance to activate and the
  // overflow leaks to the page instead. The table's min-width itself is
  // intentionally left alone (columns must stay legible; scrolling is
  // meant to be contained right here, one level up).
  return (

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
            <th scope="col" className="px-4 py-2.5">Work</th>
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
                <WorkReference
                  workId={item.workId}
                  label={item.workTitle ?? undefined}
                  correlationStatus={item.correlationStatus}
                  onSelectWork={onSelectWork}
                  onReview={onReviewCorrelation ? () => onReviewCorrelation(item.executionId) : undefined}
                  isHumanCorrected={item.isHumanCorrected}
                />
              </td>

            </tr>

          ))}
        </tbody>

      </table>

    </div>

  );

}
