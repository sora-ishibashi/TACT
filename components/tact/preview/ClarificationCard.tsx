"use client";

import { useState } from "react";
import Button from "../ui/Button";
import Card from "../ui/Card";
import StatusBadge from "../ui/StatusBadge";
import Textarea from "../ui/Textarea";
import type { PreviewClarification } from "./mockWorks";

export default function ClarificationCard({ clarification }: { clarification: PreviewClarification }) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <Card className="border-l-2 border-l-[#C53F4B] p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[13px] font-medium leading-[18px] text-[#112278]">確認が必要です</h2>
        <StatusBadge label={submitted ? "回答済み" : "回答待ち"} tone={submitted ? "success" : "attention"} />
      </div>
      <p className="mt-3 text-[14px] leading-5 text-[#112278]">{clarification.question}</p>
      <label className="mt-4 block text-[12px] font-medium leading-4 text-[#626161]" htmlFor="clarification-answer">回答</label>
      <Textarea id="clarification-answer" className="mt-1.5" value={answer} onChange={(event) => { setAnswer(event.target.value); setSubmitted(false); }} placeholder={clarification.placeholder} rows={4} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!answer.trim()} onClick={() => setSubmitted(true)}>回答を送信</Button>
        <span className="text-[11px] leading-4 text-[#626161]">プレビュー: 回答は送信されません。</span>
      </div>
      {submitted && <p className="mt-3 text-[12px] leading-4 text-[#172E95]">回答を受け付けました。実際の送信は行いません。</p>}
    </Card>
  );
}
