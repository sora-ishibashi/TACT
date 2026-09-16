"use client";

import { useState, type ReactNode } from "react";
import { CalendarDays, Check, Clock3, FolderCog, Info, LockKeyhole, ShieldCheck, SlidersHorizontal } from "lucide-react";
import Card from "../ui/Card";
import SectionHeader from "../ui/SectionHeader";
import StatusBadge from "../ui/StatusBadge";
import ConnectionsPanel from "../connections/ConnectionsPanel";
import SettingsNav, { SETTINGS_CATEGORIES, type SettingsCategory } from "./SettingsNav";
import Toggle from "./Toggle";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function PreviewNote() {
  return (
    <p className="mt-2 text-[13px] leading-[18px] text-[#626161]">
      Changes only live in this preview. They are not saved to your account.
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

function PreviewHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="border-b border-[#D9D9D9] pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">{title}</h1>
        <StatusBadge label="Preview" tone="neutral" />
      </div>
      <p className="mt-2 text-[14px] leading-5 text-[#626161]">{description}</p>
      <PreviewNote />
    </header>
  );
}

export default function SettingsPreview() {
  const [category, setCategory] = useState<SettingsCategory>("general");
  const [displayName, setDisplayName] = useState("TACT user");
  const [language, setLanguage] = useState("ja");
  const [timezone, setTimezone] = useState("Asia/Tokyo");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [workingDays, setWorkingDays] = useState<string[]>(["Mon", "Tue", "Wed", "Thu", "Fri"]);
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
        <p className="px-3 text-[12px] font-medium leading-4 text-[#626161]">Settings</p>
        <div className="mt-3"><SettingsNav active={category} onSelect={setCategory} /></div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <label className="block lg:hidden">
            <span className="sr-only">Settings category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as SettingsCategory)} className={fieldClass}>
              {SETTINGS_CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>

          <div className="mt-4 lg:mt-0">
            {category === "general" && (
              <>
                <PreviewHeader title="General" description="Personal display and language preferences for the TACT preview." />
                <div className="mt-6 space-y-5">
                  <Card><Field label="Display name"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={fieldClass} /></Field></Card>
                  <Card className="grid gap-5 sm:grid-cols-2">
                    <Field label="Language"><select value={language} onChange={(event) => setLanguage(event.target.value)} className={fieldClass}><option value="ja">Japanese</option><option value="en">English</option></select></Field>
                    <Field label="Timezone" helper="Used to display dates and times in this preview."><select value={timezone} onChange={(event) => setTimezone(event.target.value)} className={fieldClass}><option>Asia/Tokyo</option><option>America/New_York</option><option>Europe/London</option></select></Field>
                  </Card>
                </div>
              </>
            )}

            {category === "scheduling" && (
              <>
                <PreviewHeader title="Scheduling" description="Set understandable availability defaults for candidate suggestions." />
                <div className="mt-6 space-y-5">
                  <Card className="space-y-5">
                    <SectionHeader title="Availability" description="These values are local preview controls; they do not change Calendar behavior." />
                    <div className="grid gap-5 sm:grid-cols-3">
                      <Field label="Scheduling timezone"><select value={timezone} onChange={(event) => setTimezone(event.target.value)} className={fieldClass}><option>Asia/Tokyo</option><option>America/New_York</option><option>Europe/London</option></select></Field>
                      <Field label="Available from"><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} className={fieldClass} /></Field>
                      <Field label="Available until"><input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} className={fieldClass} /></Field>
                    </div>
                    <div><p className="text-[13px] font-medium leading-[18px] text-[#112278]">Working days</p><div className="mt-2 flex flex-wrap gap-2">{DAYS.map((day) => <button key={day} type="button" aria-pressed={workingDays.includes(day)} onClick={() => toggleDay(day)} className={`h-9 min-w-11 border px-3 text-[13px] font-medium transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${workingDays.includes(day) ? "border-[#18B5A6] bg-[#E6F2F2] text-[#172E95]" : "border-[#D9D9D9] bg-white text-[#626161] hover:bg-[#E6F2F2]"}`}>{day}</button>)}</div></div>
                  </Card>
                  <Card className="space-y-5">
                    <SectionHeader title="Candidate defaults" description="A requested 30-minute meeting needs a longer free window when buffers are included." />
                    <div className="grid gap-5 sm:grid-cols-3">
                      <Field label="Candidate count"><select value={candidateCount} onChange={(event) => setCandidateCount(event.target.value)} className={fieldClass}><option value="3">3</option><option value="5">5</option></select></Field>
                      <Field label="Before-meeting buffer"><select value={beforeBuffer} onChange={(event) => setBeforeBuffer(event.target.value)} className={fieldClass}><option value="0">None</option><option value="15">15 min</option><option value="30">30 min</option></select></Field>
                      <Field label="After-meeting buffer"><select value={afterBuffer} onChange={(event) => setAfterBuffer(event.target.value)} className={fieldClass}><option value="0">None</option><option value="15">15 min</option><option value="30">30 min</option></select></Field>
                    </div>
                    <div className="flex gap-3 border-l-2 border-[#18B5A6] bg-[#E6F2F2] px-3 py-3"><Clock3 aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[#172E95]" /><p className="text-[13px] leading-[18px] text-[#112278]">For a 30-minute requested meeting, TACT would eventually require a {effectiveWindow}-minute free window before suggesting a candidate.</p></div>
                  </Card>
                </div>
              </>
            )}

            {category === "connections" && (
              <>
                <PreviewHeader title="Connections" description="Manage currently supported services, with Calendar availability clearly marked as preview support." />
                <div className="mt-6 space-y-5"><Card><ConnectionsPanel /></Card><Card><div className="flex items-start justify-between gap-4"><div><p className="text-[14px] font-medium leading-5 text-[#112278]">Google Calendar</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">Availability support for scheduling. This card does not represent a connected account and does not start OAuth.</p></div><StatusBadge label="Preview" tone="neutral" /></div></Card></div>
              </>
            )}

            {category === "notifications" && (
              <>
                <PreviewHeader title="Notifications" description="Choose local preview defaults for the updates you would want to receive." />
                <div className="mt-6 space-y-5"><Card className="space-y-4"><SectionHeader title="Notify me about" />{[["completed", "Work completed"], ["approval", "Approval required"], ["clarification", "Input or clarification required"], ["failed", "Work failed"]].map(([key, label]) => <div key={key} className="flex items-center justify-between gap-4 border-t border-[#D9D9D9] pt-4 first:border-t-0 first:pt-0"><span className="text-[14px] leading-5 text-[#112278]">{label}</span><Toggle label={label} checked={notifications[key as keyof typeof notifications]} onChange={(checked) => setNotifications((current) => ({ ...current, [key]: checked }))} /></div>)}</Card><Card className="space-y-4"><SectionHeader title="Destinations" description="Only the visual preference changes in this preview." />{[["inApp", "In-app"], ["slack", "Slack"], ["email", "Email"]].map(([key, label]) => <div key={key} className="flex items-center justify-between gap-4 border-t border-[#D9D9D9] pt-4 first:border-t-0 first:pt-0"><span className="text-[14px] leading-5 text-[#112278]">{label}</span><Toggle label={label} checked={notifications[key as keyof typeof notifications]} onChange={(checked) => setNotifications((current) => ({ ...current, [key]: checked }))} /></div>)}<div className="flex items-center justify-between border-t border-[#D9D9D9] pt-4"><span className="text-[14px] leading-5 text-[#626161]">LINE</span><StatusBadge label="Coming later" tone="muted" /></div></Card></div>
              </>
            )}

            {category === "workspace" && (
              <>
                <PreviewHeader title="Data & Workspace" description="A future place to understand what information TACT may use for your work." />
                <div className="mt-6 grid gap-4 sm:grid-cols-2">{[[FolderCog, "Local Workspace", "Files you explicitly make available to TACT."], [CalendarDays, "Connected folders", "Future folder access and review controls."], [SlidersHorizontal, "Connected SaaS sources", "Future enablement for approved connected sources."], [Info, "Future Work Scope", "A future boundary for the information a Work may use."]].map(([Icon, title, description]) => <Card key={title as string}><Icon aria-hidden="true" size={18} className="text-[#172E95]" /><p className="mt-3 text-[14px] font-medium leading-5 text-[#112278]">{title as string}</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">{description as string}</p><div className="mt-3"><StatusBadge label="Coming later" tone="muted" /></div></Card>)}</div>
              </>
            )}

            {category === "security" && (
              <>
                <PreviewHeader title="Security" description="TACT keeps approval and external-action boundaries visible rather than hiding them behind automation." />
                <div className="mt-6 space-y-4">{[[Check, "Read actions", "Normally allowed when the requested read capability is available."], [ShieldCheck, "External send", "Requires approval before TACT sends information outside your workspace."], [LockKeyhole, "Write, delete, and share", "Restricted and approval-controlled; this preview does not change policy."]].map(([Icon, title, description]) => <Card key={title as string} className="flex gap-3"><Icon aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[#172E95]" /><div><p className="text-[14px] font-medium leading-5 text-[#112278]">{title as string}</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">{description as string}</p></div></Card>)}<Card className="bg-[#F2F2F2]"><div className="flex items-center justify-between gap-4"><div><p className="text-[14px] font-medium leading-5 text-[#626161]">Enterprise policy controls</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">Approval, data, and external-sharing policy controls are intentionally unavailable here.</p></div><StatusBadge label="Coming later" tone="muted" /></div></Card></div>
              </>
            )}

            {category === "advanced" && (
              <>
                <PreviewHeader title="Advanced" description="Reference-only Preview information, separated from everyday settings." />
                <div className="mt-6 space-y-4"><Card className="bg-[#F2F2F2]"><p className="text-[14px] font-medium leading-5 text-[#626161]">Execution information</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">Future diagnostic summaries can explain Work execution without exposing provider credentials, account identifiers, or raw Run IDs.</p></Card><Card className="bg-[#F2F2F2]"><p className="text-[14px] font-medium leading-5 text-[#626161]">Developer diagnostics and audit detail</p><p className="mt-1 text-[13px] leading-[18px] text-[#626161]">Enterprise-only detail levels are not configurable in this Preview.</p><div className="mt-3"><StatusBadge label="Coming later" tone="muted" /></div></Card></div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
