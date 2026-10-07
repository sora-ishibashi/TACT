import type { InputHTMLAttributes, ReactNode } from "react";

export const focusRing = "runs-focus";
export const interactiveRow = `${focusRing} transition-colors duration-150 hover:bg-runs-hover motion-reduce:transition-none`;
export const selectedRow = "border-runs-interactive bg-runs-selected text-runs-text";
export const iconButton = `${focusRing} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary transition-colors duration-150 hover:bg-runs-hover hover:text-runs-text motion-reduce:transition-none`;
export const secondaryButton = `${focusRing} inline-flex min-h-9 items-center justify-center rounded-md border border-runs-border bg-runs-surface px-3 py-2 text-sm font-medium text-runs-text transition-colors duration-150 hover:bg-runs-hover disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none`;
export const primaryButton = `${focusRing} inline-flex min-h-9 items-center justify-center rounded-md border border-runs-interactive bg-runs-interactive px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-runs-interactive-hover disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none`;
export const inputClass = `${focusRing} min-h-10 w-full rounded-md border border-runs-border bg-runs-surface px-3 py-2 text-sm text-runs-text placeholder:text-runs-muted disabled:cursor-not-allowed disabled:opacity-60`;

export function PageHeader({ title, detail, actions }: { title: string; detail?: ReactNode; actions?: ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-3 border-b border-runs-border-subtle pb-4"><div className="min-w-0"><h1 className="break-words text-2xl font-semibold leading-8 text-runs-text">{title}</h1>{detail && <div className="mt-1 text-sm leading-5 text-runs-text-secondary">{detail}</div>}</div>{actions}</header>;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-semibold leading-6 text-runs-text">{children}</h2>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium text-runs-text"><span>{label}</span>{children}{hint && <span className="text-xs font-normal leading-5 text-runs-text-secondary">{hint}</span>}</label>;
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}
