import Card from "../ui/Card";
import StatusBadge from "../ui/StatusBadge";
import { ServiceIconList } from "./ServiceBadge";
import type { PreviewWork } from "./mockWorks";

type WorkCardProps = { work: PreviewWork; onOpen: (workId: string) => void };

export default function WorkCard({ work, onOpen }: WorkCardProps) {
  return (
    <button type="button" onClick={() => onOpen(work.id)} className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-[#18B5A6] focus:ring-offset-2">
      <Card className="transition duration-150 ease-out hover:border-[#18B5A6] hover:bg-[#E6F2F2]/35">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-medium leading-5 text-[#112278]">{work.title}</h3>
            <p className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-[#626161]">{work.description}</p>
          </div>
          <StatusBadge {...work.status} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[#D9D9D9] pt-3">
          <ServiceIconList services={work.services} />
          <span className="text-[12px] leading-4 text-[#626161]">更新: {work.updatedAt}</span>
        </div>
        <p className="mt-2 text-[12px] leading-4 text-[#626161]">{work.progressSummary}</p>
      </Card>
    </button>
  );
}
