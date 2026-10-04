"use client";

import { useMemo, useState } from "react";
import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import {
  actionJapanese,
  attentionDecisionPhase,
  attentionReasonJapanese,
  executionResultJapanese,
  permissionJapanese,
} from "@tact/runs-core/tact-runs-view/attentionInbox";

type InboxFilter = "all" | "needs_review" | "acknowledged";

function AttentionCard({ item, onSelectWork, onSelectExecution, onTransition }: {
  item: AttentionCardView;
  onSelectWork: (workId: string) => void;
  onSelectExecution?: (executionId: string) => void;
  onTransition: (attentionId: string, action: "acknowledge" | "resolve") => void;
}) {
  const phase = attentionDecisionPhase(item);
  const isPostExecution = phase === "post_execution";
  const action = actionJapanese(item.action);
  const target = item.targetSystem.label;
  const summary = isPostExecution
    ? `${target}で${action}が実行されました。`
    : `${target}での${action}について、人による確認が必要です。`;

  return <article className="rounded-xl border border-[#D9D9D9] bg-white p-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${isPostExecution ? "bg-[#E6F2F2] text-[#147c73]" : "bg-[#F2F2F2] text-[#626161]"}`}>
        {isPostExecution ? "実行済み" : "状態を確認できません"}
      </span>
      {item.status === "acknowledged" && <span className="text-[12px] text-[#626161]">確認済み・未解決</span>}
    </div>

    <h2 className="mt-3 text-[16px] font-medium leading-6 text-[#112278]">{summary}</h2>
    <p className="mt-1 text-[13px] leading-5 text-[#626161]">
      確認が必要な理由：{attentionReasonJapanese(item.attentionReason)}。{item.attentionReasonExplanation}
    </p>

    {isPostExecution ? (
      <dl className="mt-4 grid gap-x-5 gap-y-2 text-[13px] leading-5 sm:grid-cols-2">
        <div><dt className="text-[#8A8A8A]">何が起きたか</dt><dd className="text-[#112278]">{target}で{action}</dd></div>
        <div><dt className="text-[#8A8A8A]">結果</dt><dd className="text-[#112278]">{executionResultJapanese(item.executionStatus)}</dd></div>
        <div><dt className="text-[#8A8A8A]">AI</dt><dd className="text-[#112278]">{item.agentLabel}</dd></div>
        <div><dt className="text-[#8A8A8A]">依頼元</dt><dd className="text-[#112278]">{item.principalLabel}</dd></div>
        <div><dt className="text-[#8A8A8A]">権限の評価</dt><dd className="text-[#112278]">{permissionJapanese(item.permissionEvaluation)}</dd></div>
        {item.workId && <div><dt className="text-[#8A8A8A]">関連Work</dt><dd><button type="button" onClick={() => onSelectWork(item.workId!)} className="text-[#172E95] hover:underline">{item.workTitle ?? "Workを見る"}</button></dd></div>}
      </dl>
    ) : (
      <p className="mt-4 rounded-lg bg-[#F7F7F7] px-3 py-2 text-[13px] leading-5 text-[#626161]">
        実行前か実行済みかを、現在の記録から確認できません。危険な操作は表示しません。
      </p>
    )}

    <div className="mt-4 flex flex-wrap gap-2">
      {item.status === "open" && <button type="button" onClick={() => onTransition(item.attentionId, "acknowledge")} className="rounded-full border border-[#D9D9D9] px-3 py-1.5 text-[12px] font-medium text-[#112278] hover:border-[#172E95]">確認済みにする</button>}
      {item.status !== "resolved" && <button type="button" onClick={() => onTransition(item.attentionId, "resolve")} className="rounded-full bg-[#18B5A6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#149488]">解決済みにする</button>}
      {onSelectExecution && <button type="button" onClick={() => onSelectExecution(item.executionId)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[#172E95] hover:underline">詳細</button>}
      {!isPostExecution && item.workId && <button type="button" onClick={() => onSelectWork(item.workId!)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[#172E95] hover:underline">Workを見る</button>}
    </div>
  </article>;
}

export default function AttentionInbox({ items, onSelectWork, onSelectExecution, onTransition }: {
  items: AttentionCardView[];
  onSelectWork: (workId: string) => void;
  // SOR-185 owns the shared Execution Inspector. This is intentionally only
  // the connection contract; this component creates no execution detail view.
  onSelectExecution?: (executionId: string) => void;
  onTransition: (attentionId: string, action: "acknowledge" | "resolve") => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const counts = useMemo(() => ({ all: items.length, needs_review: items.filter((item) => item.status === "open").length, acknowledged: items.filter((item) => item.status === "acknowledged").length }), [items]);
  const visible = items.filter((item) => filter === "all" || (filter === "needs_review" ? item.status === "open" : item.status === "acknowledged"));
  const entries: Array<{ id: InboxFilter; label: string; count: number }> = [
    { id: "all", label: "すべて", count: counts.all },
    { id: "needs_review", label: "確認してください", count: counts.needs_review },
    { id: "acknowledged", label: "確認済み（未解決）", count: counts.acknowledged },
  ];

  return <section className="flex min-w-0 flex-col gap-4 lg:flex-row">
    <aside aria-label="Human Decision Inbox の分類" className="shrink-0 lg:w-48">
      <h1 className="text-[20px] font-medium text-[#112278]">Human Decision Inbox</h1>
      <p className="mt-1 text-[13px] leading-5 text-[#626161]">私は今、何を判断すればいい？</p>
      <nav className="mt-4 flex gap-2 overflow-x-auto lg:flex-col" aria-label="Inbox filters">
        {entries.map((entry) => <button key={entry.id} type="button" onClick={() => setFilter(entry.id)} className={`flex shrink-0 items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] ${filter === entry.id ? "bg-[#E6F2F2] font-medium text-[#112278]" : "text-[#626161] hover:bg-[#F7F7F7]"}`}>
          <span>{entry.label}</span><span className="ml-3 text-[12px]">{entry.count}</span>
        </button>)}
      </nav>
      <p className="mt-4 text-[11px] leading-4 text-[#8A8A8A]">優先度や「システムの問題」は、現在のcanonical read modelでは判定できないため分類していません。</p>
    </aside>
    <div className="min-w-0 flex-1 space-y-3">
      {visible.length === 0 ? <p className="text-[13px] text-[#626161]">この分類に確認が必要な項目はありません。</p> : visible.map((item) => <AttentionCard key={item.attentionId} item={item} onSelectWork={onSelectWork} onSelectExecution={onSelectExecution} onTransition={onTransition} />)}
    </div>
  </section>;
}
