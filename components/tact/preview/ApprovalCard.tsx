"use client";

import { AlertCircle } from "lucide-react";
import { useState } from "react";
import Button from "../ui/Button";
import Card from "../ui/Card";
import StatusBadge from "../ui/StatusBadge";
import ServiceBadge from "./ServiceBadge";
import type { PreviewApproval } from "./mockWorks";

type Decision = "pending" | "approved" | "rejected";

export default function ApprovalCard({ approval }: { approval: PreviewApproval }) {
  const [decision, setDecision] = useState<Decision>("pending");
  const isPending = decision === "pending";

  const decisionStatus = decision === "approved"
    ? { label: "承認済み", tone: "success" as const }
    : decision === "rejected"
      ? { label: "却下済み", tone: "danger" as const }
      : { label: "承認待ち", tone: "attention" as const };

  return (
    <Card className="border-l-2 border-l-[#C53F4B] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium leading-[18px] text-[#112278]">承認が必要です</p>
          <div className="mt-2"><ServiceBadge service={approval.service} /></div>
        </div>
        <StatusBadge {...decisionStatus} />
      </div>

      <dl className="mt-4 space-y-3 text-[13px] leading-[18px]">
        <div><dt className="text-[#626161]">操作</dt><dd className="mt-0.5 font-medium text-[#112278]">{approval.actionLabel}</dd></div>
        <div><dt className="text-[#626161]">対象</dt><dd className="mt-0.5 break-all text-[#112278]">{approval.target}</dd></div>
        <div><dt className="text-[#626161]">概要</dt><dd className="mt-0.5 text-[#112278]">{approval.summary}</dd></div>
        {approval.fields.map((field) => <div key={field.label}><dt className="text-[#626161]">{field.label}</dt><dd className="mt-0.5 text-[#112278]">{field.value}</dd></div>)}
      </dl>

      <div className="mt-4 border-t border-[#D9D9D9] pt-3 text-[13px] leading-[18px]">
        <p className="font-medium text-[#112278]">変更内容</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-[#626161]">{approval.changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </div>
      <div className="mt-3 text-[13px] leading-[18px]">
        <p className="font-medium text-[#112278]">影響</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-[#626161]">{approval.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>
      </div>
      <div className="mt-4 flex gap-2 border border-[#C53F4B]/40 bg-[#C53F4B]/5 px-3 py-2.5 text-[#C53F4B]">
        <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={16} strokeWidth={2} />
        <div className="text-[12px] leading-4">{approval.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="danger" disabled={!isPending} onClick={() => setDecision("rejected")}>却下</Button>
        <Button variant="primary" disabled={!isPending} onClick={() => setDecision("approved")}>承認</Button>
        <span className="self-center text-[11px] leading-4 text-[#626161]">プレビュー: 操作はローカル状態のみ変更します。</span>
      </div>
    </Card>
  );
}
