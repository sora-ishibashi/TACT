"use client";

import { useState } from "react";

type HomeMode = "home" | "works" | "approvals";

type PreviewWork = {
  id: "approval" | "clarification" | "running";
  title: string;
  summary: string;
  status: string;
  tone: "amber" | "blue" | "indigo";
};

const previewWorks: PreviewWork[] = [
  {
    id: "approval",
    title: "Send the monthly project update",
    summary: "A draft email is ready for review before it is sent.",
    status: "Approval required",
    tone: "amber",
  },
  {
    id: "clarification",
    title: "Schedule the design review",
    summary: "A preferred time is needed before finding a calendar slot.",
    status: "Input required",
    tone: "blue",
  },
  {
    id: "running",
    title: "Prepare the research brief",
    summary: "Collecting sources and organizing a short summary.",
    status: "Running",
    tone: "indigo",
  },
];

const toneClass: Record<PreviewWork["tone"], string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  blue: "border-sky-200 bg-sky-50 text-sky-900",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-900",
};

export default function HomeSection({ mode }: { mode: HomeMode }) {
  const [selected, setSelected] = useState<PreviewWork["id"] | null>(
    mode === "approvals" ? "approval" : null,
  );
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState("");

  const work = previewWorks.find((item) => item.id === selected);
  const title = mode === "approvals" ? "承認" : mode === "works" ? "ワーク" : "ホーム";

  if (work) {
    return (
      <main className="min-w-0 flex-1 overflow-y-auto bg-[#F7F8FC] px-6 py-8 lg:px-10">
        <div className="mx-auto max-w-3xl">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="mb-6 text-sm font-medium text-[#112278] hover:underline"
          >
            ← Back to {title}
          </button>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#626161]">Local preview</p>
          <h1 className="mt-2 text-2xl font-semibold text-[#112278]">{work.title}</h1>
          <p className="mt-2 text-sm text-[#626161]">{work.summary}</p>

          <section className="mt-7 border border-[#D9D9D9] bg-white p-5">
            <div className={`inline-flex border px-2 py-1 text-xs font-medium ${toneClass[work.tone]}`}>
              {work.status}
            </div>

            {work.id === "approval" && (
              <div className="mt-5 space-y-4">
                <div>
                  <h2 className="font-semibold text-[#112278]">Send email to the project team</h2>
                  <p className="mt-1 text-sm text-[#626161]">Target: project-team@example.com</p>
                </div>
                <div className="border-l-2 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">
                  This action cannot be undone after the message is sent.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setMessage("Rejected in this local preview.")} className="border border-[#B6B6B6] px-3 py-2 text-sm font-medium text-[#112278] hover:bg-[#F7F8FC]">Reject</button>
                  <button type="button" onClick={() => setMessage("Approved in this local preview.")} className="bg-[#112278] px-3 py-2 text-sm font-medium text-white hover:bg-[#1C368D]">Approve</button>
                </div>
              </div>
            )}

            {work.id === "clarification" && (
              <div className="mt-5">
                <label htmlFor="preview-answer" className="block text-sm font-semibold text-[#112278]">Which timezone should be used?</label>
                <textarea id="preview-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} rows={4} className="mt-2 w-full border border-[#B6B6B6] p-3 text-sm text-[#112278] outline-none focus:border-[#112278]" placeholder="For example, Asia/Tokyo" />
                <button type="button" onClick={() => setMessage(answer.trim() ? "Response saved in this local preview." : "Enter a response first.")} className="mt-3 bg-[#112278] px-3 py-2 text-sm font-medium text-white hover:bg-[#1C368D]">Submit response</button>
              </div>
            )}

            {work.id === "running" && (
              <ol className="mt-5 space-y-3 text-sm text-[#112278]">
                <li className="flex gap-3"><span className="font-semibold">1</span><span>Collecting sources</span></li>
                <li className="flex gap-3"><span className="font-semibold">2</span><span>Drafting the brief</span></li>
                <li className="flex gap-3 text-[#626161]"><span className="font-semibold">3</span><span>Preparing a result</span></li>
              </ol>
            )}

            {message && <p role="status" className="mt-4 text-sm text-[#35626A]">{message}</p>}
          </section>
        </div>
      </main>
    );
  }

  const visibleWorks = mode === "approvals" ? previewWorks.filter((work) => work.id === "approval") : previewWorks;

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#F7F8FC] px-6 py-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#626161]">Local preview</p>
        <h1 className="mt-2 text-2xl font-semibold text-[#112278]">{title}</h1>
        <p className="mt-2 text-sm text-[#626161]">Preview-only work states. They do not call a Work, Approval, or Clarification API.</p>
        <div className="mt-7 grid gap-4 lg:grid-cols-3">
          {visibleWorks.map((work) => (
            <button key={work.id} type="button" onClick={() => setSelected(work.id)} className="border border-[#D9D9D9] bg-white p-5 text-left transition hover:border-[#112278] hover:shadow-sm">
              <span className={`inline-flex border px-2 py-1 text-xs font-medium ${toneClass[work.tone]}`}>{work.status}</span>
              <h2 className="mt-4 font-semibold text-[#112278]">{work.title}</h2>
              <p className="mt-2 text-sm leading-6 text-[#626161]">{work.summary}</p>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
