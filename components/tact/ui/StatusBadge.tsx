import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Circle,
  LoaderCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";

export type StatusTone =
  | "neutral"
  | "processing"
  | "attention"
  | "success"
  | "danger"
  | "muted";

type StatusBadgeProps = {
  label: string;
  tone: StatusTone;
  showActivity?: boolean;
};

type TonePresentation = {
  className: string;
  icon: LucideIcon;
};

const TONE_PRESENTATION: Record<StatusTone, TonePresentation> = {
  neutral: { className: "border-[#D9D9D9] bg-white text-[#626161]", icon: Circle },
  processing: { className: "border-[#18B5A6]/40 bg-[#E6F2F2] text-[#172E95]", icon: LoaderCircle },
  attention: { className: "border-[#C53F4B]/35 bg-[#C53F4B]/5 text-[#C53F4B]", icon: AlertCircle },
  success: { className: "border-[#18B5A6]/40 bg-[#E6F2F2] text-[#172E95]", icon: CheckCircle2 },
  danger: { className: "border-[#C53F4B]/45 bg-[#C53F4B]/5 text-[#C53F4B]", icon: XCircle },
  muted: { className: "border-[#D9D9D9] bg-[#F2F2F2] text-[#626161]", icon: Ban },
};

export default function StatusBadge({ label, tone, showActivity = false }: StatusBadgeProps) {
  const presentation = TONE_PRESENTATION[tone];
  const Icon = presentation.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium leading-4 ${presentation.className}`}>
      <Icon aria-hidden="true" className={showActivity || tone === "processing" ? "animate-spin" : undefined} size={13} strokeWidth={2} />
      {label}
    </span>
  );
}
