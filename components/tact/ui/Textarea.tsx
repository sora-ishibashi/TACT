import type { TextareaHTMLAttributes } from "react";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export default function Textarea({ className = "", ...props }: TextareaProps) {
  return (
    <textarea
      {...props}
      className={`min-h-24 w-full resize-y border border-[#D9D9D9] bg-white px-3 py-2.5 text-[14px] leading-5 text-[#112278] outline-none transition placeholder:text-[#8A8A8A] focus:border-[#18B5A6] focus:ring-2 focus:ring-[#18B5A6] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A] ${className}`}
    />
  );
}
