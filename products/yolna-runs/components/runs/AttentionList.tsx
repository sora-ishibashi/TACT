"use client";

// =========================
// AttentionList (SOR-54 Screen 2: Needs Attention, SOR-48/SOR-18 Lifecycle)
// =========================
//
// SOR-52のlistExecutionAttentions()から読んだAttentionCardView[]を
// そのまま描画するだけ。Attention eligibility(何がAttentionになるか)
// の判定はここに一切無い(絶対条件、SOR-54指示「Attention source」)。
// UNKNOWNはM-0ではAttentionを生成しない(SOR-52仕様)ため、このlistへ
// UNKNOWNのcardが独自に追加されることも無い。
//
// SOR-48/SOR-18(Human Owner指示): 遷移(acknowledge/resolve)の判定
// (状態機械・冪等性・所有権)はこのcomponentに一切無い——onTransition
// 経由でPATCH /api/tact/runs/attention/[attentionId]を呼ぶ呼び出し元
// (RunsSection)へ完全に委譲する。Execution Detail画面はこのtaskでは
// 作らない(Human Owner指示、Activity Explorer laneへ明示的に委譲)
// ——代わりに、安定した人間可読なExecution識別子(短縮id)だけを表示する。

import type { AttentionCardView } from "@tact/runs-core/tact-runs-view";
import { AttentionReasonBadge, AttentionStatusBadge, PermissionBadge, ResultBadge, WorkReference } from "./badges";

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

// Execution Detail画面がこのtaskでは存在しない(Human Owner指示、
// dedicated deep-linkはActivity Explorer laneへ明示的に委譲)ため、
// リンクではなく「安定した人間可読な識別子」として短縮表示のみを行う
// (fullIdはtitle属性でcopy/support用途に残す)。
function formatExecutionId(executionId: string): string {
  return executionId.length > 8 ? executionId.slice(0, 8) : executionId;
}

export default function AttentionList({
  items,
  onSelectWork,
  onTransition,
}: {
  items: AttentionCardView[];
  onSelectWork: (workId: string) => void;
  onTransition: (attentionId: string, action: "acknowledge" | "resolve") => void;
}) {

  if (items.length === 0) {

    return (
      <p className="text-[13px] leading-[18px] text-[#626161]">
        現在、確認が必要なExecutionはありません。
      </p>
    );

  }

  return (

    <ul className="flex flex-col gap-3">

      {items.map((item) => (

        <li
          key={item.attentionId}
          className="rounded-xl border border-[#D9D9D9] bg-white px-4 py-3"
        >

          <div className="flex flex-wrap items-center justify-between gap-2">

            <div className="flex flex-wrap items-center gap-2">
              <AttentionReasonBadge reason={item.attentionReason} />
              <AttentionStatusBadge status={item.status} />
              <span className="text-[12px] text-[#626161]">{formatTimestamp(item.createdAt)}</span>
            </div>

            {item.workId ? (
              <WorkReference
                workId={item.workId}
                label={item.workTitle ?? item.workId}
                correlationStatus="CORRELATED"
                onSelectWork={onSelectWork}
              />
            ) : (
              <span className="text-[10px] font-medium text-[#8A8A8A]">Unassigned</span>
            )}

          </div>

          <p className="mt-2 text-[13px] leading-[18px] text-[#112278]">
            {item.attentionReasonExplanation}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] leading-[18px] text-[#112278] sm:grid-cols-4">

            <div>
              <dt className="text-[10px] uppercase tracking-wide text-[#8A8A8A]">Principal</dt>
              <dd>{item.principalLabel}</dd>
            </div>

            <div>
              <dt className="text-[10px] uppercase tracking-wide text-[#8A8A8A]">Agent</dt>
              <dd>{item.agentLabel}</dd>
            </div>

            <div>
              <dt className="text-[10px] uppercase tracking-wide text-[#8A8A8A]">SaaS</dt>
              <dd>
                {item.targetSystem.label}
                {item.targetSystem.subLabel && (
                  <span className="ml-1 text-[10px] text-[#8A8A8A]">{item.targetSystem.subLabel}</span>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-[10px] uppercase tracking-wide text-[#8A8A8A]">Action</dt>
              <dd className="font-medium">{item.action}</dd>
            </div>

          </dl>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">

            <div className="flex flex-wrap items-center gap-2">
              <PermissionBadge result={item.permissionEvaluation} />
              <ResultBadge status={item.executionStatus} />
              <span
                className="text-[10px] text-[#8A8A8A]"
                title={item.executionId}
              >
                Execution {formatExecutionId(item.executionId)}
              </span>
            </div>

            {item.status !== "resolved" && (
              <div className="flex items-center gap-2">
                {item.status === "open" && (
                  <button
                    type="button"
                    onClick={() => onTransition(item.attentionId, "acknowledge")}
                    className="rounded-full border border-[#D9D9D9] px-3 py-1 text-[12px] font-medium text-[#112278] transition duration-150 ease-out hover:border-[#172E95] hover:text-[#172E95]"
                  >
                    Acknowledge
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onTransition(item.attentionId, "resolve")}
                  className="rounded-full bg-[#18B5A6] px-3 py-1 text-[12px] font-medium text-white transition duration-150 ease-out hover:bg-[#149488]"
                >
                  Resolve
                </button>
              </div>
            )}

          </div>

        </li>

      ))}

    </ul>

  );

}
