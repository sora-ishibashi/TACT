"use client";

export default function SettingsView({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6"><div className="max-w-2xl"><header className="border-b border-[#E5E5E5] pb-2"><h1 className="text-[20px] font-semibold leading-7 text-[#171717]">設定</h1></header><section className="border-b border-[#E5E5E5] py-5"><h2 className="text-[14px] font-semibold text-[#171717]">アカウント</h2><p className="mt-2 text-[13px] text-[#626161]">メールアドレス</p><p className="mt-1 truncate text-[14px] text-[#171717]">{email}</p><button type="button" onClick={onSignOut} className="mt-4 text-[13px] font-medium text-[#172E95] hover:underline">ログアウト</button></section><section className="border-b border-[#E5E5E5] py-5"><h2 className="text-[14px] font-semibold text-[#171717]">運用</h2><p className="mt-2 text-[13px] text-[#626161]">権限、接続・観測、AI の管理はサイドバーから開けます。</p></section></div></main>;
}
