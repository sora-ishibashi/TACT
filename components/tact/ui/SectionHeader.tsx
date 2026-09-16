import type { ReactNode } from "react";

type SectionHeaderProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

export default function SectionHeader({ title, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-[16px] font-medium leading-6 text-[#112278]">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-[18px] text-[#626161]">{description}</p>}
      </div>
      {action}
    </div>
  );
}
