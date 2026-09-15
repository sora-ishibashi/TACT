import ActivityTimeline from "./ActivityTimeline";
import ApprovalCard from "./ApprovalCard";
import CandidateSlotCard from "./CandidateSlotCard";
import ClarificationCard from "./ClarificationCard";
import ResultCard from "./ResultCard";
import RunStatusNote from "./RunStatusNote";
import WorkHeader from "./WorkHeader";
import WorkProgressStep from "./WorkProgressStep";
import type { PreviewWork } from "./mockWorks";
import Card from "../ui/Card";
import ErrorBanner from "../ui/ErrorBanner";
import SectionHeader from "../ui/SectionHeader";

export default function WorkDetailPreview({ work, onBack }: { work: PreviewWork; onBack: () => void }) {
  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-white px-5 py-6 text-[#112278] sm:px-8">
      <div className="mx-auto max-w-6xl">
        <WorkHeader work={work} onBack={onBack} />
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="xl:col-start-1">
            <SectionHeader title="依頼内容" />
            <Card className="mt-3"><p className="whitespace-pre-wrap text-[14px] leading-6 text-[#112278]">{work.request}</p></Card>
          </section>

          {(work.approval || work.clarification) && (
            <section className="xl:col-start-2 xl:row-start-1">
              <SectionHeader title="対応が必要です" />
              <div className="mt-3">{work.approval ? <ApprovalCard approval={work.approval} /> : <ClarificationCard clarification={work.clarification!} />}</div>
            </section>
          )}

          <section className="xl:col-start-1">
            <SectionHeader title="進捗" description={work.progressSummary} />
            <Card className="mt-3">
              <ol>{work.progress.map((step, index) => <WorkProgressStep key={step.id} step={step} index={index} />)}</ol>
            </Card>
          </section>

          {work.candidateSlots && (
            <section className="xl:col-start-2 xl:row-start-2">
              <CandidateSlotCard slots={work.candidateSlots} />
            </section>
          )}

          <section className="xl:col-start-1">
            <SectionHeader title="アクティビティ" />
            <Card className="mt-3"><ActivityTimeline activities={work.activity} /></Card>
          </section>

          {work.error && (
            <section className="space-y-3 xl:col-start-2 xl:row-start-3">
              <ErrorBanner title="Workを完了できませんでした" message={work.error} />
              <RunStatusNote label="再試行を待機" tone="attention" detail="再試行の実行はこのプレビューでは行いません。" />
            </section>
          )}

          {work.result && (
            <section className="xl:col-start-1">
              <ResultCard result={work.result} />
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
