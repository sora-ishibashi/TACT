"use client";

import { useState, type ReactNode } from "react";
import { CalendarDays, Check, Clock3, FolderCog, Info, LockKeyhole, ShieldCheck, SlidersHorizontal } from "lucide-react";
import Card from "../ui/Card";
import SectionHeader from "../ui/SectionHeader";
import StatusBadge from "../ui/StatusBadge";
import ConnectionsPanel from "../connections/ConnectionsPanel";
import SettingsNav, { SETTINGS_CATEGORIES, type SettingsCategory } from "./SettingsNav";
import Toggle from "./Toggle";

const DAYS = ["月", "火", "水", "木", "金", "土", "日"] as const;

function PreviewNote() {
  return (
    <p className="mt-2 text-[13px] leading-[18px] text-[#626161]">
      この変更はプレビュー内でのみ反映され、アカウントには保存されません。
    </p>
  );
}

function Field({ label, children, helper }: { label: string; children: ReactNode; helper?: string }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium leading-[18px] text-[#112278]">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {helper && <span className="mt-1 block text-[12px] leading-4 text-[#626161]">{helper}</span>}
    </label>
  );
}

const fieldClass = "h-10 w-full border border-[#D9D9D9] bg-white px-3 text-[14px] leading-5 text-[#112278] outline-none transition-colors duration-150 ease-out focus:border-[#18B5A6] focus:ring-2 focus:ring-[#18B5A6]";

function PreviewHeader({
  title,
  description,
  label = "プレビュー",
  tone = "neutral",
  isPreview = true,
}: {
  title: string;
  description: string;
  label?: string;
  tone?: "neutral" | "success";
  isPreview?: boolean;
}) {
  return (
    <header className="border-b border-[#D9D9D9] pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">{title}</h1>
        <StatusBadge label={label} tone={tone} />
      </div>
      <p className="mt-2 text-[14px] leading-5 text-[#626161]">{description}</p>
      {isPreview && <PreviewNote />}
    </header>
  );
}

export default function SettingsPreview({ initialCategory = "general" }: { initialCategory?: SettingsCategory }) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [displayName, setDisplayName] = useState("TACTユーザー");
  const [language, setLanguage] = useState("ja");
  const [timezone, setTimezone] = useState("Asia/Tokyo");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [workingDays, setWorkingDays] = useState<string[]>(["月", "火", "水", "木", "金"]);
  const [candidateCount, setCandidateCount] = useState("3");
  const [beforeBuffer, setBeforeBuffer] = useState("15");
  const [afterBuffer, setAfterBuffer] = useState("15");
  const [notifications, setNotifications] = useState({ completed: true, approval: true, clarification: true, failed: true, inApp: true, slack: false, email: false });

  const toggleDay = (day: string) => {
    setWorkingDays((current) => current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day]);
  };

  const effectiveWindow = 30 + Number(beforeBuffer) + Number(afterBuffer);
  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-white text-[#112278]">
      <aside className="hidden w-52 shrink-0 border-r border-[#D9D9D9] px-3 py-6 lg:block">
        <p className="px-3 text-[12px] font-medium leading-4 text-[#626161]">設定</p>
        <div className="mt-3"><SettingsNav active={category} onSelect={setCategory} /></div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <label className="block lg:hidden">
            <span className="sr-only">設定カテゴリ</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as SettingsCategory)} className={fieldClass}>
              {SETTINGS_CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>

          <div className="mt-4 lg:mt-0">
            {category === "general" && (
              <>
                <PreviewHeader title="一般" description="TACTプレビューの表示名と言語を設定します。" />
                <div className="mt-6 space-y-5">
                  <Card><Field label="表示名"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={fieldClass} /></Field></Card>
                  <Card className="grid gap-5 sm:grid-cols-2">
                    <Field label="言語"><select value={language} onChange={(event) => setLanguage(event.target.value)} className={fieldClass}><option value="ja">日本語</option><option value="en">英語</option></select></Field>
                    <Field label="タイムゾーン" helper="プレビュー内の日付と時刻の表示に使用します。"><select value={timezone} onChange={(event) => setTimezone(event.target.value)} className={fieldClass}><option>Asia/Tokyo</option><option>America/New_York</option><option>Europe/London</option></select></Field>
                  </Card>
                </div>
              </>
            )}

            {category === "scheduling" && (
              <>
                <PreviewHeader title="スケジュール" description="候補日時を提案するための稼働可能時間を設定します。" />
                <div className="mt-6 space-y-5">
                  <Card className="space-y-5">
                    <SectionHeader title="稼働可能時間" description="これらはプレビュー内だけの設定で、Google Calendarの動作は変更されません。" />
                    <div className="grid gap-5 sm:grid-cols-3">
                      <Field label="スケジュール用タイムゾーン"><select value={timezone} onChange={(event) => setTimezone(event.target.value)} className={fieldClass}><option>Asia/Tokyo</option><option>America/New_York</option><option>Europe/London</option></select></Field>
                      <Field label="開始時刻"><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} className={fieldClass} /></Field>
                      <Field label="終了時刻"><input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} className={fieldClass} /></Field>
                    </div>
                    <div><p className="text-[13px] font-medium leading-[18px] text-[#112278]">稼働日</p><div className="mt-2 flex flex-wrap gap-2">{DAYS.map((day) => <button key={day} type="button" aria-pressed={workingDays.includes(day)} onClick={() => toggleDay(day)} className={`h-9 min-w-11 border px-3 text-[13px] font-medium transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${workingDays.includes(day) ? "border-[#18B5A6] bg-[#E6F2F2] text-[#172E95]" : "border-[#D9D9D9] bg-white text-[#626161] hover:bg-[#E6F2F2]"}`}>{day}</button>)}</div></div>
                  </Card>
                  <Card className="space-y-5">
                    <SectionHeader title="候補日時の初期設定" description="30分の予定でも、前後のバッファを含めた空き時間が必要です。" />
                    <div className="grid gap-5 sm:grid-cols-3">
                      <Field label="候補数"><select value={candidateCount} onChange={(event) => setCandidateCount(event.target.value)} className={fieldClass}><option value="3">3</option><option value="5">5</option></select></Field>
                      <Field label="予定前のバッファ"><select value={beforeBuffer} onChange={(event) => setBeforeBuffer(event.target.value)} className={fieldClass}><option value="0">なし</option><option value="15">15分</option><option value="30">30分</option></select></Field>
                      <Field label="予定後のバッファ"><select value={afterBuffer} onChange={(event) => setAfterBuffer(event.target.value)} className={fieldClass}><option value="0">なし</option><option value="15">15分</option><option value="30">30分</option></select></Field>
                    </div>
                    <div className="flex gap-3 border-l-2 border-[#18B5A6] bg-[#E6F2F2] px-3 py-3"><Clock3 aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[#172E95]" /><p className="text-[13px] leading-[18px] text-[#112278]">30分の予定を提案するには、候補を提示する前に{effectiveWindow}分の空き時間が必要です。</p></div>
                  </Card>
                </div>
              </>
            )}

            {category === "connections" && (
              <>
                <PreviewHeader title="接続" description="現在対応しているサービスと接続状態を管理します。" label="利用可能" tone="success" isPreview={false} />
                <div className="mt-6"><Card><ConnectionsPanel /></Card></div>
              </>
            )}

            {category === "notifications" && (
              <>
                <PreviewHeader title="通知" description="受け取りたい更新のプレビュー設定を選択します。" />
                <div className="mt-6 space-y-5"><Card className="space-y-4"><SectionHeader title="通知する内容" />{[["completed", "ワークが完了"], ["approval", "承認が必要"], ["clarification", "入力または確認が必要"], ["failed", "ワークが失敗"]].map(([key, label]) => <div key={key} className="flex items-center justify-between gap-4 border-t border-[#D9D9D9] pt-4 first:border-t-0 first:pt-0"><span className="text-[14px] leading-5 text-[#112278]">{label}</span><Toggle label={label} checked={notifications[key as keyof typeof notifications]} onChange={(checked) => setNotifications((current) => ({ ...current, [key]: checked }))} /></div>)}</Card><Card className="space-y-4"><SectionHeader title="通知先" description="このプレビューで変更されるのは表示上の設定だけです。" />{[["inApp", "アプリ内"], ["slack", "Slack"], ["email", "メール"]].map(([key, label]) => <div key={key} className="flex items-center justify-between gap-4 border-t border-[#D9D9D9] pt-4 first:border-t-0 first:pt-0"><span className="text-[14px] leading-5 text-[#112278]">{label}</span><Toggle label={label} checked={notifications[key as keyof typeof notifications]} onChange={(checked) => setNotifications((current) => ({ ...current, [key]: checked }))} /></div>)}<div className="flex items-center justify-between border-t border-[#D9D9D9] pt-4"><span className="text-[14px] leading-5 text-[#626161]">LINE</span><StatusBadge label="今後対応" tone="muted" /></div></Card></div>
              </>
            )}

            {category === "workspace" && (
              <>
                <PreviewHeader title="データとワークスペース" description="TACTがワークで利用する情報を確認するための将来の設定です。" />
                <div className="mt-6 grid gap-4 sm:grid-cols-2">{[[FolderCog, "ローカルワークスペース", "TACTが明示的に利用できるファイル。"], [CalendarDays, "接続済みフォルダ", "今後追加されるフォルダアクセスと確認の設定。"], [SlidersHorizontal, "接続済みSaaS", "承認済みの接続先を有効化するための将来の設定。"], [Info, "今後のワーク範囲", "ワークが利用できる情報の範囲を定める将来の境界。"]].map(([Icon, title, description]) => <Card key={title as string}><Icon aria-hidden="true" size={18} className="text-[#172E95]" /><p className="mt-3 text-[14px] font-medium leading-5 text-[#112278]">{title as string}</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">{description as string}</p><div className="mt-3"><StatusBadge label="今後対応" tone="muted" /></div></Card>)}</div>
              </>
            )}

            {category === "security" && (
              <>
                <PreviewHeader title="セキュリティ" description="承認と外部アクションの境界を明確に確認できます。" />
                <div className="mt-6 space-y-4">{[[Check, "読み取り操作", "必要な読み取り権限がある場合に通常利用できます。"], [ShieldCheck, "外部への送信", "ワークスペース外へ情報を送信する前に承認が必要です。"], [LockKeyhole, "書き込み、削除、共有", "制限および承認の対象です。このプレビューではポリシーは変更されません。"]].map(([Icon, title, description]) => <Card key={title as string} className="flex gap-3"><Icon aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[#172E95]" /><div><p className="text-[14px] font-medium leading-5 text-[#112278]">{title as string}</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">{description as string}</p></div></Card>)}<Card className="bg-[#F2F2F2]"><div className="flex items-center justify-between gap-4"><div><p className="text-[14px] font-medium leading-5 text-[#626161]">組織向けポリシー設定</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">承認、データ、外部共有に関するポリシー設定はここでは利用できません。</p></div><StatusBadge label="今後対応" tone="muted" /></div></Card></div>
              </>
            )}

            {category === "advanced" && (
              <>
                <PreviewHeader title="詳細設定" description="日常的な設定とは分けて表示する参照専用のプレビュー情報です。" />
                <div className="mt-6 space-y-4"><Card className="bg-[#F2F2F2]"><p className="text-[14px] font-medium leading-5 text-[#626161]">実行情報</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">将来の診断サマリーでは、認証情報、アカウント識別子、Run IDを表示せずにワークの実行状況を説明します。</p></Card><Card className="bg-[#F2F2F2]"><p className="text-[14px] font-medium leading-5 text-[#626161]">開発者向け診断と監査の詳細</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">組織向けの詳細レベルは、このプレビューでは設定できません。</p><div className="mt-3"><StatusBadge label="今後対応" tone="muted" /></div></Card></div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
