import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "border border-[#18B5A6] bg-[#18B5A6] text-white hover:bg-white hover:text-[#18B5A6]",
  secondary:
    "border border-[#D9D9D9] bg-white text-[#112278] hover:bg-[#E6F2F2]",
  ghost:
    "border border-transparent bg-transparent text-[#112278] hover:bg-[#E6F2F2]",
  danger:
    "border border-[#C53F4B] bg-white text-[#C53F4B] hover:bg-[#C53F4B]/5",
};

export default function Button({
  children,
  className = "",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`inline-flex h-9 items-center justify-center gap-2 px-3 text-[14px] font-medium leading-5 transition duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] focus:ring-offset-2 disabled:cursor-not-allowed disabled:border-[#F2F2F2] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A] ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
