import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = { title: string; description: string; action?: ReactNode };

export default function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center border border-dashed border-[#D9D9D9] bg-white px-6 py-8 text-center">
      <Inbox aria-hidden="true" className="text-[#626161]" size={24} strokeWidth={1.5} />
      <h3 className="mt-3 text-[13px] font-medium leading-[18px] text-[#112278]">{title}</h3>
      <p className="mt-1 max-w-md text-[13px] leading-[18px] text-[#626161]">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
