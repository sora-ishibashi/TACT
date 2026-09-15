import StatusBadge from "../ui/StatusBadge";
import type { PreviewProgressStep as PreviewProgressStepData } from "./mockWorks";

export default function WorkProgressStep({ step, index }: { step: PreviewProgressStepData; index: number }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#D9D9D9] bg-white text-[11px] font-medium text-[#626161]">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-[13px] font-medium leading-[18px] text-[#112278]">{step.label}</p>
          <StatusBadge {...step.status} />
        </div>
        <p className="mt-1 text-[12px] leading-4 text-[#626161]">{step.detail}</p>
      </div>
    </li>
  );
}
