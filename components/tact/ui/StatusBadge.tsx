type StatusTone = "neutral" | "success" | "muted" | "warning" | "error" | "info";

const toneClass: Record<StatusTone, string> = {
  neutral: "border-[#D9D9D9] bg-white text-[#626161]",
  success: "border-[#9BD6CC] bg-[#E6F2F2] text-[#35626A]",
  muted: "border-[#D9D9D9] bg-[#F2F2F2] text-[#626161]",
  warning: "border-[#E9C46A] bg-[#FFF5D6] text-[#7A5C00]",
  error: "border-[#E7A6AE] bg-[#FFF0F2] text-[#A12D3A]",
  info: "border-[#B9C8F2] bg-[#EEF2FF] text-[#172E95]",
};

export default function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: StatusTone }) {
  return <span className={`inline-flex shrink-0 border px-2 py-1 text-[12px] font-medium leading-4 ${toneClass[tone]}`}>{label}</span>;
}
