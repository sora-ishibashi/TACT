"use client";

import { ChevronRightIcon } from "@/components/icons/RunsIcons";

function NavigationRow({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="flex w-full items-center justify-between border-b border-[#E5E5E5] py-3 text-left text-[13px] text-[#171717] outline-none hover:bg-[#FAFAFA] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6]"><span>{label}</span><ChevronRightIcon className="text-[#8A8A8A]" /></button>; }

export default function SettingsView({ email, onSignOut, onOpenPermission, onOpenCoverage, onOpenAgent }: { email: string; onSignOut: () => void; onOpenPermission: () => void; onOpenCoverage: () => void; onOpenAgent: () => void }) {
  return <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6"><div className="max-w-2xl"><header className="border-b border-[#E5E5E5] pb-2"><h1 className="text-[20px] font-semibold leading-7 text-[#171717]">設定</h1></header><section className="py-5"><h2 className="text-[14px] font-semibold text-[#171717]">運用</h2><div className="mt-2"><NavigationRow label="権限" onClick={onOpenPermission} /><NavigationRow label="接続・観測" onClick={onOpenCoverage} /><NavigationRow label="AI" onClick={onOpenAgent} /></div></section><section className="border-t border-[#E5E5E5] py-5"><h2 className="text-[14px] font-semibold text-[#171717]">アカウント</h2><p className="mt-2 text-[13px] text-[#626161]">メールアドレス</p><p className="mt-1 truncate text-[14px] text-[#171717]">{email}</p><button type="button" onClick={onSignOut} className="mt-4 text-[13px] font-medium text-[#172E95] hover:underline">ログアウト</button></section></div></main>;
}
