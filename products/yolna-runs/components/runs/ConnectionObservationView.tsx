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
  if (classification === "HEALTHY") return "bg-runs-selected text-runs-success";
  if (classification === "PARTIAL") return "bg-runs-warning-surface text-runs-warning";
  if (classification === "OUTAGE") return "bg-runs-danger-surface text-runs-danger";
  return "bg-runs-hover text-runs-text-secondary";
}

type ConnectionObservationProps = {
  details: CoverageServiceDetailView[];
  state: PresentationStateKind | null;
  selectedSurfaceId: string | null;
  mode?: "connection" | "observation";
  onOpenDetails?: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-b border-runs-border-subtle py-4 first:pt-0 last:border-b-0 last:pb-0"><h3 className="text-xs font-semibold text-runs-text-secondary">{title}</h3>{children}</section>;
}

export function ConnectionObservationView(props: ConnectionObservationProps) {
  if (props.state) return <PresentationState kind={props.state} />;
  if (props.details.length === 0) return <PresentationState kind="empty" />;
  if (!props.selectedSurfaceId) return <p className="text-sm text-runs-text-secondary">左の一覧から{props.mode === "connection" ? "接続" : "観測対象"}を選択してください。</p>;
  const detail = props.details.find((item) => item.surfaceId === props.selectedSurfaceId) ?? null;
  if (!detail) return <PresentationState kind="unavailable" />;
  const isConnection = props.mode === "connection";
  const heading = isConnection ? (detail.connection.service ?? detail.source) : detail.source;

  return <div className="flex min-w-0 max-w-5xl flex-col">
    <header className="flex items-start justify-between gap-4 border-b border-runs-border-subtle pb-4">
      <div className="min-w-0"><h1 className="break-words text-2xl font-semibold leading-8 text-runs-text">{heading}</h1>{isConnection ? <p className="mt-2 text-xs text-runs-text-secondary">{detail.connection.statusLabel ?? detail.connection.unavailableMessage}</p> : <div className="mt-2 flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${classificationTone(detail.classification)}`}>{detail.classificationLabel}</span><span className="text-xs text-runs-text-secondary">最終観測: {formatDateTime(detail.lastSeenAt)}</span></div>}</div>
      {props.onOpenDetails && <button type="button" onClick={props.onOpenDetails} aria-label={`${isConnection ? "接続" : "観測"}の技術詳細を開く`} title={`${isConnection ? "接続" : "観測"}の技術詳細を開く`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover hover:text-runs-text focus-visible:ring-2 focus-visible:ring-runs-focus"><DetailsIcon /></button>}
    </header>

    {props.mode !== "connection" && detail.activeGap && <section className="border-b border-runs-border-subtle py-4"><div className="flex items-start gap-2 text-runs-warning"><WarningIcon className="mt-0.5 shrink-0" /><div><h2 className="text-sm font-semibold">Capture Gap</h2><p className="mt-1 text-xs leading-5">{detail.activeGap.reason}</p><p className="mt-0.5 text-xs text-runs-text-secondary">検出: {formatDateTime(detail.activeGap.detectedAt)}{detail.activeGap.affectedScope ? ` · ${detail.activeGap.affectedScope}` : ""}</p></div></div></section>}

    {props.mode !== "observation" ? <Section title="接続"><div className="mt-2 text-sm">{detail.connection.joined ? <><p className="text-runs-text">{detail.connection.service}{detail.connection.provider ? ` · ${detail.connection.provider}` : ""}</p><p className="mt-1 text-runs-text-secondary">{detail.connection.statusLabel}</p></> : <p className="text-runs-text-secondary">{detail.connection.unavailableMessage}</p>}</div></Section> : null}
    {props.mode !== "connection" ? <Section title="観測"><dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2"><div><dt className="text-xs text-runs-muted">対象サービス</dt><dd className="mt-1 text-sm text-runs-text">{detail.providerLabel}</dd></div><div><dt className="text-xs text-runs-muted">観測方式</dt><dd className="mt-1 text-sm text-runs-text">{detail.observationModeLabel}</dd></div><div><dt className="text-xs text-runs-muted">最終観測</dt><dd className="mt-1 text-sm text-runs-text">{formatDateTime(detail.lastSeenAt)}</dd></div><div><dt className="text-xs text-runs-muted">権限事前確認</dt><dd className="mt-1 text-sm text-runs-text">{detail.permissionPrecheckAvailable ? "利用可能" : "確認できません"}</dd></div></dl></Section> : null}
  </div>;
}

export function ConnectionObservationPeek({ onClose, ...props }: ConnectionObservationProps & { onClose: () => void }) {
  if (props.state) return null;
  const detail = props.details.find((item) => item.surfaceId === props.selectedSurfaceId) ?? null;
  if (!detail) return null;

  const isObservation = props.mode === "observation";
  return <DetailPeek title={`${detail.source} の詳細`} onClose={onClose}>
    <div className="flex min-w-0 flex-col">
      <Section title={isObservation ? "観測の技術情報" : "接続の技術情報"}><dl className="mt-2 space-y-2 text-xs"><div><dt className="text-runs-muted">識別情報の伝達</dt><dd className="mt-0.5 break-words text-runs-text">{detail.identityTransport ?? "確認できません"}</dd></div><div><dt className="text-runs-muted">Work情報の伝達</dt><dd className="mt-0.5 break-words text-runs-text">{detail.workContextTransport ?? "確認できません"}</dd></div>{isObservation && <div><dt className="text-runs-muted">観測可能な機能</dt><dd className="mt-0.5 break-words text-runs-text">{detail.observableCapabilities.length > 0 ? detail.observableCapabilities.join("、") : "確認できません"}</dd></div>}</dl></Section>
      {isObservation && <Section title="Capture Gap履歴"><div className="mt-2 space-y-3">{detail.gaps.length ? detail.gaps.map((gap) => <div key={gap.gapId} className="text-xs"><p className="text-runs-text">{formatDateTime(gap.detectedAt)} · {gap.reason}</p><p className={`mt-0.5 ${gap.isActive ? "text-runs-warning" : "text-runs-text-secondary"}`}>{gap.affectedScope ?? "範囲未確認"} · {gap.isActive ? "未解消" : `解消: ${formatDateTime(gap.resolvedAt)}`}</p><p className="mt-0.5 text-runs-muted">confidence: {gap.confidence}</p></div>) : <p className="text-sm text-runs-text-secondary">Capture Gapはありません。</p>}</div></Section>}
    </div>
  </DetailPeek>;
}
