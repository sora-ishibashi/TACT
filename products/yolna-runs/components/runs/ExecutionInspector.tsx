"use client";

import { useEffect, useState } from "react";
import { InspectorPanel } from "@/components/shell/ShellContainers";
import { PresentationState, presentationStateForHttp, type PresentationStateKind } from "@/components/shell/PresentationState";
import type { CorrelationReviewView } from "@tact/runs-core/tact-runs-view";
import type { ExecutionInspectorViewModel } from "@/lib/executionInspector";

export type ExecutionInspectorProps = {
  executionId: string | null;
  accessToken: string | null;
  onClose: () => void;
};

const unavailable = "\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093";
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : unavailable;
const Field = ({ label, value }: { label: string; value: string | null }) => <div><dt className="text-[11px] text-[#626161]">{label}</dt><dd className="mt-0.5 break-words text-[13px] text-[#112278]">{value ?? unavailable}</dd></div>;

/** Shared Execution Inspector contract. Mount it from any screen and call its onSelectExecution boundary with an execution id. */
export function ExecutionInspector({ executionId, accessToken, onClose }: ExecutionInspectorProps) {
  const [model, setModel] = useState<ExecutionInspectorViewModel | null>(null);
  const [correlation, setCorrelation] = useState<CorrelationReviewView | null>(null);
  const [state, setState] = useState<PresentationStateKind | null>(null);

  useEffect(() => {
    if (!executionId) return;
    if (!accessToken) { setState("unavailable"); return; }
    let cancelled = false;
    setModel(null); setCorrelation(null); setState("loading");
    void Promise.all([
      fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}/correlation`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    ]).then(async ([detail, correlationResponse]) => {
      const detailBody = await detail.json().catch(() => null);
      const correlationBody = await correlationResponse.json().catch(() => null);
      if (cancelled) return;
      if (!detail.ok || !detailBody?.success) { setState(presentationStateForHttp(detail.status)); return; }
      setModel(detailBody.inspector as ExecutionInspectorViewModel);
      if (correlationResponse.ok && correlationBody?.success) setCorrelation(correlationBody.correlation as CorrelationReviewView);
      setState(null);
    }).catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [executionId, accessToken]);

  if (!executionId) return null;
  const jp = {
    title: "\u5b9f\u884c\u306e\u8a73\u7d30", close: "\u9589\u3058\u308b", overview: "\u6982\u8981", principal: "\u4f9d\u983c\u5143", service: "\u30b5\u30fc\u30d3\u30b9", action: "\u64cd\u4f5c", target: "\u5bfe\u8c61", result: "\u7d50\u679c", occurred: "\u767a\u751f\u6642\u523b", observed: "\u89b3\u6e2c\u6642\u523b", work: "\u4ed5\u4e8b", correlation: "\u4ed5\u4e8b\u3078\u306e\u7d10\u3065\u3051", permission: "\u6a29\u9650", evidence: "\u5224\u5b9a\u6839\u62e0", technical: "\u6280\u8853\u60c5\u5831",
  };
  return <InspectorPanel><div className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[12px] text-[#626161]">{jp.title}</p><h2 className="mt-1 text-[18px] font-medium text-[#112278]">Execution Inspector</h2></div><button type="button" onClick={onClose} className="text-[12px] text-[#626161] hover:text-[#112278]">{jp.close}</button></div>
    {state ? <div className="mt-5"><PresentationState kind={state} /></div> : model && <div className="mt-5 space-y-6">
      <section><h3 className="text-[13px] font-medium text-[#112278]">{jp.overview}</h3><p className="mt-2 text-[14px] leading-6 text-[#112278]">{model.summary.actionSentence}</p><dl className="mt-3 grid grid-cols-2 gap-3"><Field label="AI" value={model.summary.ai}/><Field label={jp.principal} value={model.summary.principal}/><Field label={jp.service} value={model.summary.provider}/><Field label={jp.action} value={model.summary.action}/><Field label={jp.target} value={model.summary.resource}/><Field label={jp.result} value={model.summary.result}/><Field label={jp.occurred} value={formatTime(model.summary.occurredAt)}/><Field label={jp.observed} value={formatTime(model.summary.observedAt)}/><Field label={jp.work} value={correlation?.currentWorkTitle ?? (model.summary.workId ? "\u4ed5\u4e8b\u540d\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093" : "\u7d10\u3065\u3044\u3066\u3044\u307e\u305b\u3093")}/></dl></section>
      <section><h3 className="text-[13px] font-medium text-[#112278]">{jp.correlation}</h3>{correlation ? <dl className="mt-3 grid grid-cols-2 gap-3"><Field label="\u72b6\u614b" value={correlation.currentStatus}/><Field label="\u65b9\u6cd5" value={correlation.methodLabel}/><Field label="\u4fe1\u983c\u5ea6" value={correlation.confidence === null ? null : String(correlation.confidence)}/><Field label="\u7406\u7531" value={correlation.reasonCode}/>{correlation.correction && <Field label="\u8a02\u6b63\u5c65\u6b74" value={`${correlation.correction.correlatedAt} / ${correlation.correction.reasonCode}`}/>}</dl> : <p className="mt-2 text-[13px] text-[#626161]">\u3053\u306e\u4ed5\u4e8b\u3078\u306e\u7d10\u3065\u3051\u306f\u73fe\u5728\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3002</p>}<p className="mt-3 text-[12px] text-[#626161]">\u8a02\u6b63\u306f\u65e2\u5b58\u306eSOR-77 \u76f8\u95a2\u30ec\u30d3\u30e5\u30fc\u304b\u3089\u884c\u3044\u307e\u3059\u3002</p></section>
      <section><h3 className="text-[13px] font-medium text-[#112278]">{jp.permission}</h3><dl className="mt-3 grid grid-cols-2 gap-3"><Field label="Runs\u767b\u9332\u6a29\u9650" value={model.permission.registered}/><Field label="\u8a55\u4fa1" value={model.permission.evaluation}/><Field label="\u7406\u7531" value={model.permission.reason}/></dl><p className="mt-3 text-[12px] text-[#626161]">{model.permission.downstream.length === 0 ? "\u4e0b\u6d41\u306e\u6a29\u9650\u8a3c\u8de1\u306f\u3042\u308a\u307e\u305b\u3093\u3002\u3053\u308c\u306f\u62d2\u5426\u3092\u610f\u5473\u3057\u307e\u305b\u3093\u3002" : `\u4e0b\u6d41\u306e\u6a29\u9650\u8a3c\u8de1: ${model.permission.downstream.map((item) => `${item.state} (${item.authority})`).join(", ")}`}</p></section>
      <section><h3 className="text-[13px] font-medium text-[#112278]">{jp.evidence}</h3><p className="mt-2 text-[13px] text-[#626161]">\u3053\u306e\u5224\u5b9a\u6839\u62e0\u306f\u73fe\u5728\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3002</p></section>
      <details><summary className="cursor-pointer text-[13px] font-medium text-[#112278]">{jp.technical}</summary><dl className="mt-3 grid grid-cols-2 gap-3"><Field label="\u89b3\u6e2c\u65b9\u6cd5" value={model.technical.observationMode}/><Field label="\u89b3\u6e2c\u5143" value={model.technical.sourceType}/><Field label="executionId" value={model.executionId}/><Field label="invocationId" value={model.technical.invocationId}/><Field label="traceId" value={model.technical.traceId}/><Field label="spanId" value={model.technical.spanId}/><Field label="raw observation reference" value={model.technical.rawObservationReference}/></dl></details>
    </div>}</div></InspectorPanel>;
}
