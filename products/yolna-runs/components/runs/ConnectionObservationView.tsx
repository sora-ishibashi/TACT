"use client";

import type { ReactNode } from "react";
import type { CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { DetailsIcon, WarningIcon } from "@/components/icons/RunsIcons";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { DetailPeek } from "@/components/shell/DetailPeek";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

function classificationTone(classification: CoverageServiceDetailView["classification"]): string {
  if (classification === "HEALTHY") return "bg-[#E6F2F2] text-[#16835D]";
  if (classification === "PARTIAL") return "bg-[#B7791F]/10 text-[#B7791F]";
  if (classification === "OUTAGE") return "bg-[#C53F4B]/10 text-[#C53F4B]";
  return "bg-[#F2F2F2] text-[#737373]";
}

type ConnectionObservationProps = {
  details: CoverageServiceDetailView[];
  state: PresentationStateKind | null;
  selectedSurfaceId: string | null;
  onOpenDetails?: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-[#E5E5E5] py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-[12px] font-semibold text-[#626161]">{title}</h3>{children}</section>;
}

export function ConnectionObservationView(props: ConnectionObservationProps) {
  if (props.state) return <PresentationState kind={props.state} />;
  if (props.details.length === 0) return <PresentationState kind="empty" />;
  if (!props.selectedSurfaceId) return <p className="text-[13px] text-[#626161]">左の一覧から観測対象を選択してください。</p>;
  const detail = props.details.find((item) => item.surfaceId === props.selectedSurfaceId) ?? null;
  if (!detail) return <PresentationState kind="unavailable" />;

  return <div className="flex min-w-0 max-w-5xl flex-col">
    <header className="flex items-start justify-between gap-4 border-b border-[#E5E5E5] pb-4">
      <div className="min-w-0"><h1 className="break-words text-[22px] font-semibold leading-8 text-[#171717]">{detail.source}</h1><div className="mt-2 flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${classificationTone(detail.classification)}`}>{detail.classificationLabel}</span><span className="text-[12px] text-[#626161]">最終観測: {formatDateTime(detail.lastSeenAt)}</span></div></div>
      {props.onOpenDetails && <button type="button" onClick={props.onOpenDetails} aria-label="接続・観測の技術詳細を開く" title="接続・観測の技術詳細を開く" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#626161] outline-none hover:bg-[#F7F7F7] hover:text-[#171717] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><DetailsIcon /></button>}
    </header>

    {detail.activeGap && <section className="border-b border-[#E5E5E5] py-4"><div className="flex items-start gap-2 text-[#B7791F]"><WarningIcon className="mt-0.5 shrink-0" /><div><h2 className="text-[13px] font-semibold">Capture Gap</h2><p className="mt-1 text-[12px] leading-5">{detail.activeGap.reason}</p><p className="mt-0.5 text-[11px] text-[#626161]">検出: {formatDateTime(detail.activeGap.detectedAt)}{detail.activeGap.affectedScope ? ` · ${detail.activeGap.affectedScope}` : ""}</p></div></div></section>}

    <Section title="接続"><div className="mt-2 text-[13px]">{detail.connection.joined ? <><p className="text-[#171717]">{detail.connection.service}{detail.connection.provider ? ` · ${detail.connection.provider}` : ""}</p><p className="mt-1 text-[#626161]">{detail.connection.statusLabel}</p></> : <p className="text-[#626161]">{detail.connection.unavailableMessage}</p>}</div></Section>
    <Section title="観測"><dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2"><div><dt className="text-[11px] text-[#8A8A8A]">対象サービス</dt><dd className="mt-1 text-[13px] text-[#171717]">{detail.providerLabel}</dd></div><div><dt className="text-[11px] text-[#8A8A8A]">観測方式</dt><dd className="mt-1 text-[13px] text-[#171717]">{detail.observationModeLabel}</dd></div><div><dt className="text-[11px] text-[#8A8A8A]">最終観測</dt><dd className="mt-1 text-[13px] text-[#171717]">{formatDateTime(detail.lastSeenAt)}</dd></div><div><dt className="text-[11px] text-[#8A8A8A]">権限事前確認</dt><dd className="mt-1 text-[13px] text-[#171717]">{detail.permissionPrecheckAvailable ? "利用可能" : "確認できません"}</dd></div></dl></Section>
  </div>;
}

export function ConnectionObservationPeek({ onClose, ...props }: ConnectionObservationProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.surfaceId === props.selectedSurfaceId) ?? null;
  if (!detail) return null;

  return <DetailPeek title={`${detail.source} の詳細`} onClose={onClose}>
    <div className="flex min-w-0 flex-col">
      <Section title="技術情報"><dl className="mt-2 space-y-2 text-[12px]"><div><dt className="text-[#8A8A8A]">識別情報の伝達</dt><dd className="mt-0.5 break-words text-[#171717]">{detail.identityTransport ?? "確認できません"}</dd></div><div><dt className="text-[#8A8A8A]">Work情報の伝達</dt><dd className="mt-0.5 break-words text-[#171717]">{detail.workContextTransport ?? "確認できません"}</dd></div><div><dt className="text-[#8A8A8A]">観測可能な機能</dt><dd className="mt-0.5 break-words text-[#171717]">{detail.observableCapabilities.length > 0 ? detail.observableCapabilities.join("、") : "確認できません"}</dd></div></dl></Section>
      <Section title="Capture Gap履歴"><div className="mt-2 space-y-3">{detail.gaps.length ? detail.gaps.map((gap) => <div key={gap.gapId} className="text-[12px]"><p className="text-[#171717]">{formatDateTime(gap.detectedAt)} · {gap.reason}</p><p className={`mt-0.5 ${gap.isActive ? "text-[#B7791F]" : "text-[#626161]"}`}>{gap.affectedScope ?? "範囲未確認"} · {gap.isActive ? "未解消" : `解消: ${formatDateTime(gap.resolvedAt)}`}</p><p className="mt-0.5 text-[#8A8A8A]">confidence: {gap.confidence}</p></div>) : <p className="text-[13px] text-[#626161]">Capture Gapはありません。</p>}</div></Section>
    </div>
  </DetailPeek>;
}
