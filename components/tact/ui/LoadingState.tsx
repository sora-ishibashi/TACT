import { LoaderCircle } from "lucide-react";

type LoadingStateProps = { label?: string };

export default function LoadingState({ label = "読み込み中..." }: LoadingStateProps) {
  return (
    <p className="flex items-center gap-2 text-[13px] leading-[18px] text-[#626161]" role="status">
      <LoaderCircle aria-hidden="true" className="animate-spin text-[#18B5A6]" size={16} strokeWidth={2} />
      {label}
    </p>
  );
}
