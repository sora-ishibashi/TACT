"use client";

type Props = {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export default function Toggle({ checked, label, onChange, disabled = false }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-[#18B5A6] bg-[#18B5A6]" : "border-[#D9D9D9] bg-[#F2F2F2]"
      }`}
    >
      <span className={`h-4 w-4 rounded-full bg-white transition-transform duration-150 ease-out ${checked ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}
