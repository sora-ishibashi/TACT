import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export default function Card({ children, className = "", ...props }: CardProps) {
  return (
    <div
      {...props}
      className={`border border-[#D9D9D9] bg-white p-4 text-[#112278] ${className}`}
    >
      {children}
    </div>
  );
}
