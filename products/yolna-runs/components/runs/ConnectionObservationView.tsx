"use client";

import type { ReactNode } from "react";
import type { CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

function classificationTone(classification: CoverageServiceDetailView["classification"]): string {
  if (classification === "HEALTHY") return "bg-[#E6F2F2] text-[#18B5A6]";
  if (classification === "OUTAGE" || classification === "PARTIAL") return "bg-[#C53F4B]/10 text-[#C53F4B]";
  return "bg-[#F2F2F2] text-[#8A8A8A]";
}

type ConnectionObservationProps = { details: CoverageServiceDetailView[]; state: PresentationStateKind | null; selectedSurfaceId: string | null };

export function ConnectionObservationView({ details, state }: Pick<ConnectionObservationProps, "details" | "state">) {
  if (state) return <PresentationState kind={state} />;
  if (details.length === 0) return <PresentationState kind="empty" />;
  return <p className="text-[13px] text-[#626161]">左の一覧から接続先を選択すると詳細を確認できます。</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#D9D9D9] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[13px] font-medium text-[#112278]">{title}</h3>{children}</section>;
}

export function ConnectionObservationPeek({ onClose, ...props }: ConnectionObservationProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.surfaceId === props.selectedSurfaceId) ?? null;
  if (!detail) return null;
  return <DetailPeek title="接続・観測の詳細" onClose={onClose}>
    <div className="flex min-w-0 flex-col px-5 py-4">
      <header className="flex items-start justify-between gap-3 pb-4"><p className="text-[16px] font-medium text-[#112278]">{detail.source}</p><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${classificationTone(detail.classification)}`}>{detail.classificationLabel}</span></header>
      {detail.activeGap && <p className="mb-4 rounded-lg border border-[#C53F4B]/30 bg-[#C53F4B]/5 p-3 text-[12px] text-[#C53F4B]">観測に欠落があります。検出: {formatDateTime(detail.activeGap.detectedAt)} · {detail.activeGap.reason}</p>}
      <Section title="接続"><div className="mt-2 text-[13px]">{detail.connection.joined ? <><p className="text-[#112278]">{detail.connection.service} · {detail.connection.provider}</p><p className="mt-1 text-[#626161]">{detail.connection.statusLabel}</p></> : <p className="text-[#626161]">{detail.connection.unavailableMessage}</p>}</div></Section>
      <Section title="観測"><dl className="mt-2 space-y-1 text-[12px]"><div><dt className="inline text-[#8A8A8A]">対象: </dt><dd className="inline text-[#112278]">{detail.providerLabel}</dd></div><div><dt className="inline text-[#8A8A8A]">方式: </dt><dd className="inline text-[#112278]">{detail.observationModeLabel}</dd></div><div><dt className="inline text-[#8A8A8A]">最終観測: </dt><dd className="inline text-[#112278]">{formatDateTime(detail.lastSeenAt)}</dd></div><div><dt className="inline text-[#8A8A8A]">権限事前確認: </dt><dd className="inline text-[#112278]">{detail.permissionPrecheckAvailable ? "利用可能" : "確認できません"}</dd></div><div><dt className="inline text-[#8A8A8A]">Identity transport: </dt><dd className="inline text-[#112278]">{detail.identityTransport ?? "確認できません"}</dd></div><div><dt className="inline text-[#8A8A8A]">Work context transport: </dt><dd className="inline text-[#112278]">{detail.workContextTransport ?? "確認できません"}</dd></div>{detail.observableCapabilities.length > 0 && <div><dt className="inline text-[#8A8A8A]">観測可能な機能: </dt><dd className="inline text-[#112278]">{detail.observableCapabilities.join("、")}</dd></div>}</dl></Section>
      <Section title="Capture Gap の履歴"><div className="mt-2 space-y-2">{detail.gaps.length ? detail.gaps.map((gap) => <div key={gap.gapId} className="text-[12px]"><p className="text-[#112278]">{formatDateTime(gap.detectedAt)} · {gap.reason}</p><p className="text-[#626161]">{gap.affectedScope ?? "範囲未確認"} · {gap.isActive ? "未解消" : `解消: ${formatDateTime(gap.resolvedAt)}`}</p></div>) : <p className="text-[13px] text-[#626161]">Capture Gap はありません。</p>}</div></Section>
    </div>
  </DetailPeek>;
}
