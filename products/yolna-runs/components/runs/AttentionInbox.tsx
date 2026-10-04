"use client";

import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import {
  actionJapanese,
  attentionDecisionPhase,
  attentionReasonJapanese,
  attentionReasonJapaneseExplanation,
  executionResultJapanese,
  permissionJapanese,
} from "@tact/runs-core/tact-runs-view/attentionInbox";

function AttentionCard({ item, onSelectWork, onSelectExecution, onOpenPermissionSettings, onTransition }: {
  item: AttentionCardView;
  onSelectWork: (workId: string) => void;
  // SOR-185 owns the Execution Inspector. This component retains only its
  // connection contract and never creates an Inspector, drawer, or modal.
  onSelectExecution?: (executionId: string) => void;
  onOpenPermissionSettings?: () => void;
  onTransition: (attentionId: string, action: "acknowledge" | "resolve") => void;
}) {
  const isPostExecution = attentionDecisionPhase(item) === "post_execution";
  const action = actionJapanese(item.action);
  const target = item.targetSystem.label;

  return <article className="rounded-xl border border-[#D9D9D9] bg-white p-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${isPostExecution ? "bg-[#E6F2F2] text-[#147c73]" : "bg-[#F2F2F2] text-[#626161]"}`}>
        {isPostExecution ? "実行記録あり" : "状態を確認できません"}
      </span>
      <span className="text-[12px] text-[#626161]">{item.status === "open" ? "対応待ち" : "確認済み・未解決"}</span>
    </div>

    <h2 className="mt-3 text-[16px] font-medium leading-6 text-[#112278]">
      {isPostExecution ? "この操作には実行記録があります。" : `${target}での${action}について、人による確認が必要です。`}
    </h2>
    <p className="mt-1 text-[13px] leading-5 text-[#626161]">
      確認が必要な理由：{attentionReasonJapanese(item.attentionReason)}。{attentionReasonJapaneseExplanation(item.attentionReason)}
    </p>

    {isPostExecution ? (
      <dl className="mt-4 grid gap-x-5 gap-y-2 text-[13px] leading-5 sm:grid-cols-2">
        <div><dt className="text-[#8A8A8A]">操作と対象</dt><dd className="text-[#112278]">{target}で{action}</dd></div>
        <div><dt className="text-[#8A8A8A]">実行記録の結果</dt><dd className="text-[#112278]">{executionResultJapanese(item.executionStatus)}</dd></div>
        <div><dt className="text-[#8A8A8A]">AI</dt><dd className="text-[#112278]">{item.agentLabel}</dd></div>
        <div><dt className="text-[#8A8A8A]">依頼元</dt><dd className="text-[#112278]">{item.principalLabel}</dd></div>
        <div><dt className="text-[#8A8A8A]">権限の評価</dt><dd className="text-[#112278]">{permissionJapanese(item.permissionEvaluation)}</dd></div>
        {item.workId && <div><dt className="text-[#8A8A8A]">関連する仕事</dt><dd><button type="button" onClick={() => onSelectWork(item.workId!)} className="text-[#172E95] hover:underline">{item.workTitle ?? "仕事を見る"}</button></dd></div>}
      </dl>
    ) : (
      <p className="mt-4 rounded-lg bg-[#F7F7F7] px-3 py-2 text-[13px] leading-5 text-[#626161]">
        実行前か実行済みかを、現在の記録から確認できません。危険な操作は表示しません。
      </p>
    )}

    <div className="mt-4 flex flex-wrap gap-2">
      {item.status === "open" && <button type="button" onClick={() => onTransition(item.attentionId, "acknowledge")} className="rounded-full border border-[#D9D9D9] px-3 py-1.5 text-[12px] font-medium text-[#112278] hover:border-[#172E95]">確認済みにする</button>}
      <button type="button" onClick={() => onTransition(item.attentionId, "resolve")} className="rounded-full bg-[#18B5A6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#149488]">解決済みにする</button>
      {onOpenPermissionSettings && <button type="button" onClick={onOpenPermissionSettings} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[#172E95] hover:underline">権限設定を見る</button>}
      {onSelectExecution && <button type="button" onClick={() => onSelectExecution(item.executionId)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[#172E95] hover:underline">詳細</button>}
      {!isPostExecution && item.workId && <button type="button" onClick={() => onSelectWork(item.workId!)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[#172E95] hover:underline">仕事を見る</button>}
    </div>
  </article>;
}

export default function AttentionInbox(props: {
  items: AttentionCardView[];
  onSelectWork: (workId: string) => void;
  onSelectExecution?: (executionId: string) => void;
  onOpenPermissionSettings?: () => void;
  onTransition: (attentionId: string, action: "acknowledge" | "resolve") => void;
}) {
  if (props.items.length === 0) return null;
  return <div className="space-y-3">{props.items.map((item) => <AttentionCard key={item.attentionId} item={item} onSelectWork={props.onSelectWork} onSelectExecution={props.onSelectExecution} onOpenPermissionSettings={props.onOpenPermissionSettings} onTransition={props.onTransition} />)}</div>;
}
