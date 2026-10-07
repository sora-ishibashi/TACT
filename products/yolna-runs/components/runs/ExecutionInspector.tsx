"use client";

import { useEffect, useMemo, useState } from "react";
import { DetailPeek } from "@/components/shell/DetailPeek";
import { PresentationState, presentationStateForHttp, type PresentationStateKind } from "@/components/shell/PresentationState";
import type { CorrelationReviewView } from "@tact/runs-core/tact-runs-view";
import type { ExecutionInspectorViewModel } from "@/lib/executionInspector";

export type ExecutionInspectorProps = { executionId: string | null; accessToken: string | null; onClose: () => void };

const unavailable = "確認できません";
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : unavailable;
const Field = ({ label, value, strong = false }: { label: string; value: string | null; strong?: boolean }) => <div className="min-w-0"><dt className="text-xs font-medium text-runs-text-secondary">{label}</dt><dd className={`mt-1 break-words text-sm leading-6 ${strong ? "font-semibold" : "font-medium"} text-runs-text`}>{value ?? unavailable}</dd></div>;
const correlationStatusLabel: Record<CorrelationReviewView["currentStatus"], string> = { CORRELATED: "紐づけ済み", AMBIGUOUS: "判断が必要", UNASSIGNED: "未割り当て" };
const correlationMethodLabel: Record<string, string> = { Explicit: "明示", "Structural match": "文脈から判断", "Recent activity": "最近の活動から判断", "AI-assisted": "AIの補助", "Manual correction": "人が設定" };

/** Shared Execution Inspector contract. Mount it from any screen and call its onSelectExecution boundary with an execution id. */
export function ExecutionInspector({ executionId, accessToken, onClose }: ExecutionInspectorProps) {
  const authIdentity = useMemo(() => (accessToken ? {} : null), [accessToken]);
  const [response, setResponse] = useState<{ executionId: string; authIdentity: object; model: ExecutionInspectorViewModel | null; correlation: CorrelationReviewView | null; state: PresentationStateKind | null } | null>(null);

  useEffect(() => {
    if (!executionId || !accessToken || !authIdentity) return;
    const requestAuthIdentity = authIdentity;
    let cancelled = false;
    void Promise.all([
      fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}/correlation`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    ]).then(async ([detail, correlationResponse]) => {
      const detailBody = await detail.json().catch(() => null);
      const correlationBody = await correlationResponse.json().catch(() => null);
      if (cancelled) return;
      if (!detail.ok || !detailBody?.success) {
        setResponse({ executionId, authIdentity: requestAuthIdentity, model: null, correlation: null, state: presentationStateForHttp(detail.status) });
        return;
      }
      setResponse({ executionId, authIdentity: requestAuthIdentity, model: detailBody.inspector as ExecutionInspectorViewModel, correlation: correlationResponse.ok && correlationBody?.success ? correlationBody.correlation as CorrelationReviewView : null, state: null });
    }).catch(() => { if (!cancelled) setResponse({ executionId, authIdentity: requestAuthIdentity, model: null, correlation: null, state: "error" }); });
    return () => { cancelled = true; };
  }, [executionId, accessToken, authIdentity]);

  if (!executionId) return null;
  const currentResponse = response?.executionId === executionId && response.authIdentity === authIdentity ? response : null;
  const model = currentResponse?.model ?? null;
  if (model && !currentResponse?.state) {
    const primaryTime = formatTime(model.summary.occurredAt ?? model.summary.observedAt);
    const primaryWork = model.summary.workId ?? unavailable;
    return <DetailPeek title={`${model.summary.provider} \u00b7 ${model.summary.action}`} onClose={onClose}><div className="min-w-0 space-y-5">
      <section className="min-w-0 border-b border-runs-border-subtle pb-5"><dl className="space-y-4"><Field label="\u7d50\u679c" value={model.summary.result} strong/><Field label="\u30a2\u30af\u30b7\u30e7\u30f3" value={`${model.summary.provider} \u00b7 ${model.summary.action}`} strong/><Field label="AI" value={model.summary.ai}/><Field label="Work" value={primaryWork}/><Field label="\u6642\u523b" value={primaryTime}/></dl></section>
      <section className="min-w-0 border-b border-runs-border-subtle pb-5"><dl className="space-y-4"><Field label="\u5bfe\u8c61" value={model.summary.resource}/><Field label="\u4f9d\u983c\u8005" value={model.summary.principal}/>{model.summary.outcome && <Field label="\u7d50\u679c\u306e\u8a73\u7d30" value={model.summary.outcome}/>}</dl></section>
      <details className="min-w-0 border-b border-runs-border-subtle pb-5"><summary className="cursor-pointer text-xs font-semibold text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">\u6a29\u9650\u30fb\u76e3\u67fb\u60c5\u5831</summary><div className="mt-3 space-y-4"><Field label="\u6a29\u9650\u8a55\u4fa1" value={model.permission.evaluation}/><Field label="\u8a55\u4fa1\u7406\u7531" value={model.permission.reasonCode}/><Field label="\u4e0b\u6d41\u6a29\u9650" value={model.permission.downstream.length === 0 ? unavailable : model.permission.downstream.map((item) => `${item.state} (${item.authority})`).join(" / ")}/><Field label="\u9069\u7528\u30eb\u30fc\u30eb" value={model.permission.decisions.some((decision) => decision.ruleId) ? model.permission.decisions.filter((decision) => decision.ruleId).map((decision) => `${decision.ruleId} / revision ${decision.revision ?? "?"}`).join(" / ") : unavailable}/></div></details>
      <details className="min-w-0"><summary className="cursor-pointer text-xs font-semibold text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">\u6280\u8853\u30c7\u30a3\u30c6\u30fc\u30eb</summary><dl className="mt-3 grid gap-4 sm:grid-cols-2"><Field label="executionId" value={model.executionId}/><Field label="invocationId" value={model.technical.invocationId}/><Field label="traceId" value={model.technical.traceId}/><Field label="spanId" value={model.technical.spanId}/><Field label="raw observation reference" value={model.technical.rawObservationReference}/></dl></details>
    </div></DetailPeek>;
  }
  const correlation = currentResponse?.correlation ?? null;
  const state = !accessToken ? "unavailable" : currentResponse ? currentResponse.state : "loading";
  const workTitle = correlation?.currentWorkTitle ?? (model?.summary.workId ? "Work名を確認できません" : "未割り当て");
  const title = model ? `${model.summary.provider} · ${model.summary.action}` : "実行の詳細";

  return <DetailPeek title={title} onClose={onClose}><div className="min-w-0">
    {state ? <PresentationState kind={state} /> : model && <div className="min-w-0 space-y-5">
      <section className="min-w-0 border-b border-runs-border-subtle pb-5"><p className="min-w-0 break-words text-sm leading-6 text-runs-text">{model.summary.actionSentence}</p><dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-3"><Field label="AI" value={model.summary.ai}/><Field label="結果" value={model.summary.result} strong/><Field label="Work" value={workTitle}/><Field label="時刻" value={formatTime(model.summary.occurredAt ?? model.summary.observedAt)}/></dl></section>

      <section className="min-w-0 border-b border-runs-border-subtle pb-5"><h3 className="text-xs font-semibold text-runs-text-secondary">対象</h3><dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-3"><Field label="サービス" value={model.summary.provider}/><Field label="操作" value={model.summary.action}/>{model.summary.resource && <Field label="対象" value={model.summary.resource}/>}<Field label="依頼元" value={model.summary.principal}/>{model.summary.outcome && <Field label="結果の状態" value={model.summary.outcome}/>}</dl></section>

      <section className="min-w-0 border-b border-runs-border-subtle pb-5"><h3 className="text-xs font-semibold text-runs-text-secondary">Work</h3><dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3"><Field label="Work" value={workTitle}/><Field label="状態" value={correlation ? correlationStatusLabel[correlation.currentStatus] : unavailable}/></dl></section>

      <details className="min-w-0 border-b border-runs-border-subtle pb-5"><summary className="cursor-pointer text-xs font-semibold text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">権限・監査情報</summary><div className="mt-3 space-y-4"><Field label="権限判定" value={model.permission.evaluation}/><div><p className="text-xs text-runs-text-secondary">接続先で観測された権限</p><p className="mt-1 break-words text-xs text-runs-text">{model.permission.downstream.length === 0 ? "証跡はありません。これは拒否を意味しません。" : model.permission.downstream.map((item) => `${item.state} (${item.authority})`).join("、")}</p></div><div><p className="text-xs text-runs-text-secondary">登録ルール</p><p className="mt-1 break-words text-xs text-runs-text">{model.permission.decisions.some((decision) => decision.ruleId) ? model.permission.decisions.filter((decision) => decision.ruleId).map((decision) => `${decision.ruleId} / revision ${decision.revision ?? "?"}`).join("、") : unavailable}</p></div></div></details>

      <details className="min-w-0"><summary className="cursor-pointer text-xs font-semibold text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">技術情報</summary><dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3"><Field label="相関方法" value={correlation?.methodLabel ? correlationMethodLabel[correlation.methodLabel] ?? correlation.methodLabel : null}/><Field label="信頼度" value={correlation?.confidence === null || correlation?.confidence === undefined ? null : String(correlation.confidence)}/><Field label="相関理由コード" value={correlation?.reasonCode ?? null}/><Field label="訂正履歴" value={correlation?.correction?.correlatedAt ?? null}/><Field label="観測方法" value={model.technical.observationMode}/><Field label="観測元" value={model.technical.sourceType}/><Field label="権限判定理由コード" value={model.permission.reasonCode}/><Field label="executionId" value={model.executionId}/><Field label="invocationId" value={model.technical.invocationId}/><Field label="traceId" value={model.technical.traceId}/><Field label="spanId" value={model.technical.spanId}/><Field label="raw observation reference" value={model.technical.rawObservationReference}/></dl></details>
    </div>}
  </div></DetailPeek>;
}
