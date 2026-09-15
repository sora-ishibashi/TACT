import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

type ErrorBannerProps = { title?: string; message: string; action?: ReactNode };

export default function ErrorBanner({ title = "問題が発生しました", message, action }: ErrorBannerProps) {
  return (
    <div className="flex items-start gap-3 border border-[#C53F4B]/40 bg-[#C53F4B]/5 px-4 py-3 text-[#C53F4B]" role="alert">
      <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={18} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-[18px]">{title}</p>
        <p className="mt-0.5 text-[13px] leading-[18px]">{message}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
