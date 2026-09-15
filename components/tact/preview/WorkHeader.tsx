import { ArrowLeft } from "lucide-react";
import Button from "../ui/Button";
import StatusBadge from "../ui/StatusBadge";
import { ServiceIconList } from "./ServiceBadge";
import type { PreviewWork } from "./mockWorks";

export default function WorkHeader({ work, onBack }: { work: PreviewWork; onBack: () => void }) {
  return (
    <header className="border-b border-[#D9D9D9] pb-5">
      <Button variant="ghost" onClick={onBack} className="-ml-3 mb-4">
        <ArrowLeft aria-hidden="true" size={16} strokeWidth={2} />
        Homeへ戻る
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium leading-[18px] text-[#626161]">Work</p>
          <h1 className="mt-1 text-[24px] font-medium leading-[32px] text-[#112278]">{work.title}</h1>
        </div>
        <StatusBadge {...work.status} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <ServiceIconList services={work.services} />
        <span className="text-[12px] leading-4 text-[#626161]">最終更新: {work.updatedAt}</span>
      </div>
    </header>
  );
}
