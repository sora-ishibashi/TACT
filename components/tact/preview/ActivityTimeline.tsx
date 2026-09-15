import StatusBadge from "../ui/StatusBadge";
import { serviceLabel } from "./ServiceBadge";
import type { PreviewActivity } from "./mockWorks";

export default function ActivityTimeline({ activities }: { activities: readonly PreviewActivity[] }) {
  return (
    <ol className="space-y-0">
      {activities.map((activity, index) => (
        <li key={`${activity.time}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#18B5A6]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <time className="text-[12px] leading-4 text-[#626161]">{activity.time}</time>
              {activity.service && <span className="text-[12px] font-medium leading-4 text-[#172E95]">{serviceLabel(activity.service)}</span>}
              <StatusBadge {...activity.status} />
            </div>
            <p className="mt-1 text-[13px] leading-[18px] text-[#112278]">{activity.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
