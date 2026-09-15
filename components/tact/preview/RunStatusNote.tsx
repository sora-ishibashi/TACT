import { RotateCcw } from "lucide-react";
import Card from "../ui/Card";
import StatusBadge, { type StatusTone } from "../ui/StatusBadge";

export default function RunStatusNote({ label, detail, tone = "attention" }: { label: string; detail: string; tone?: StatusTone }) {
  return (
    <Card className="border-l-2 border-l-[#C53F4B] p-3">
      <div className="flex items-start gap-2">
        <RotateCcw aria-hidden="true" className="mt-0.5 shrink-0 text-[#626161]" size={16} strokeWidth={2} />
        <div>
          <StatusBadge label={label} tone={tone} />
          <p className="mt-2 text-[13px] leading-[18px] text-[#626161]">{detail}</p>
        </div>
      </div>
    </Card>
  );
}
