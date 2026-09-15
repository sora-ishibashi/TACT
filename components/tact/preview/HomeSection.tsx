"use client";

import { useState } from "react";
import SectionHeader from "../ui/SectionHeader";
import WorkCard from "./WorkCard";
import WorkDetailPreview from "./WorkDetailPreview";
import { findMockWork, mockWorks } from "./mockWorks";

export default function HomeSection() {
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const selectedWork = selectedWorkId ? findMockWork(selectedWorkId) : undefined;

  if (selectedWork) {
    return <WorkDetailPreview work={selectedWork} onBack={() => setSelectedWorkId(null)} />;
  }

  const attentionWorks = mockWorks.filter((work) => work.status.tone === "attention");
  const runningWorks = mockWorks.filter((work) => work.status.tone === "processing");
  const recentWorks = mockWorks.filter((work) => work.status.tone === "success" || work.status.tone === "danger");

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-white px-5 py-6 text-[#112278] sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-[#D9D9D9] pb-5">
          <p className="text-[13px] font-medium leading-[18px] text-[#626161]">TACT Home</p>
          <h1 className="mt-1 text-[24px] font-medium leading-[32px] text-[#112278]">Work</h1>
          <p className="mt-2 text-[14px] leading-5 text-[#626161]">いま対応が必要なこと、進行中のこと、最近の結果を確認できます。</p>
        </header>

        <div className="mt-6 space-y-8">
          <section>
            <SectionHeader title="対応が必要です" description="承認または回答を待っているWorkです。" />
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {attentionWorks.map((work) => <WorkCard key={work.id} work={work} onOpen={setSelectedWorkId} />)}
            </div>
          </section>

          <section>
            <SectionHeader title="実行中" description="現在進めているWorkです。" />
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {runningWorks.map((work) => <WorkCard key={work.id} work={work} onOpen={setSelectedWorkId} />)}
            </div>
          </section>

          <section>
            <SectionHeader title="最近の結果" description="完了したWorkと確認が必要な失敗を表示します。" />
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {recentWorks.map((work) => <WorkCard key={work.id} work={work} onOpen={setSelectedWorkId} />)}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
