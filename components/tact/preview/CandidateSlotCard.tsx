"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import Card from "../ui/Card";
import type { PreviewCandidateSlot } from "./mockWorks";

export default function CandidateSlotCard({ slots }: { slots: readonly PreviewCandidateSlot[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Card className="p-4">
      <p className="text-[13px] font-medium leading-[18px] text-[#112278]">候補日時</p>
      <p className="mt-1 text-[12px] leading-4 text-[#626161]">30分 / Asia/Tokyo。候補を選ぶプレビューです。</p>
      <div className="mt-3 space-y-2">
        {slots.map((slot, index) => {
          const selected = selectedId === slot.id;
          return (
            <button key={slot.id} type="button" onClick={() => setSelectedId(slot.id)} className={`flex w-full items-center justify-between gap-3 border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${selected ? "border-[#18B5A6] bg-[#E6F2F2]" : "border-[#D9D9D9] bg-white hover:bg-[#E6F2F2]"}`}>
              <span><span className="block text-[12px] leading-4 text-[#626161]">Candidate {index + 1}</span><span className="mt-0.5 block text-[13px] font-medium leading-[18px] text-[#112278]">{slot.label}</span><span className="mt-0.5 block text-[12px] leading-4 text-[#626161]">{slot.description}</span></span>
              {selected && <Check aria-label="選択中" className="shrink-0 text-[#18B5A6]" size={18} strokeWidth={2} />}
            </button>
          );
        })}
      </div>
      {selectedId && <p className="mt-3 text-[12px] leading-4 text-[#172E95]">候補を選択しました。Calendarへの書き込みは行いません。</p>}
    </Card>
  );
}
