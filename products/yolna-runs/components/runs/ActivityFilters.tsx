"use client";

// =========================
// ActivityFilters (SOR-23 OBS-UX-P1 Priority 3/4/5)
// =========================
//
// 絶対条件(SOR-23指示「No business logic in React」の延長): 判定
// (どのitemが残るか)は一切ここに無い——core/tact-runs-view.
// filterActivityItems()/distinctActivityFilterOptions()(pure関数)へ
// 完全に委譲する。このcomponentはcontrolled inputの集合であり、選ばれた
// ActivityItemFiltersをそのまま呼び出し元(RunsSection)へ渡すだけ。
//
// Priority 3(Unassigned/Ambiguous discoverability)は、この既存filter
// bar内のCorrelation status selectとして実現する——専用の別画面/別
// ledgerは作らない(絶対条件「no duplicate ledger」)。

import type { ActivityFilterOptions, ActivityItemFilters } from "@tact/runs-core/tact-runs-view";
import type { CanonicalPermissionResult, CanonicalCorrelationResult } from "@tact/runs-core/tact-runs-view";
import type { ExecutionStatus } from "@tact/runs-core/tact-execution/types";
import { japaneseProjection } from "@/lib/japaneseProjection";

const SELECT_CLASS =
  "h-9 rounded-xl border border-[#D9D9D9] bg-white px-2 text-[13px] text-[#112278] outline-none focus:border-[#18B5A6]";

const PERMISSION_OPTIONS: CanonicalPermissionResult[] = ["MATCH", "MISMATCH", "APPROVAL_REQUIRED", "UNKNOWN"];
const EXECUTION_STATUS_OPTIONS: ExecutionStatus[] = ["observed", "running", "succeeded", "failed", "cancelled", "unknown"];
const CORRELATION_STATUS_OPTIONS: CanonicalCorrelationResult[] = ["CORRELATED", "AMBIGUOUS", "UNASSIGNED"];

function labelForExecutionStatus(status: ExecutionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function labelForCorrelationStatus(status: CanonicalCorrelationResult): string {
  return japaneseProjection(status);
}

export default function ActivityFilters({
  filters,
  options,
  onChange,
}: {
  filters: ActivityItemFilters;
  options: ActivityFilterOptions;
  onChange: (filters: ActivityItemFilters) => void;
}) {

  const set = <K extends keyof ActivityItemFilters>(key: K, value: string) => {
    onChange({ ...filters, [key]: value === "" ? undefined : (value as ActivityItemFilters[K]) });
  };

  const hasActiveFilters = Object.values(filters).some((value) => value !== undefined && value !== "");

  return (

    // SOR-23 compact-width fix: as a flex item of RunsSection's wrapper,
    // this container defaults to min-width:auto (its own unwrapped
    // max-content width — the sum of every filter control in one line).
    // Without min-w-0 it never actually receives a constrained available
    // width from its parent, so flex-wrap has nothing to wrap against and
    // the row spills past the viewport instead of wrapping onto new lines.
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-[#D9D9D9] bg-[#F2F2F2]/40 px-3 py-2">

      <select
        aria-label="Correlation status"
        className={SELECT_CLASS}
        value={filters.correlationStatus ?? ""}
        onChange={(event) => set("correlationStatus", event.target.value)}
      >
        <option value="">すべての仕事への紐づけ</option>
        {CORRELATION_STATUS_OPTIONS.map((status) => (
          <option key={status} value={status}>{labelForCorrelationStatus(status)}</option>
        ))}
      </select>

      <select
        aria-label="Agent"
        className={SELECT_CLASS}
        value={filters.agentLabel ?? ""}
        onChange={(event) => set("agentLabel", event.target.value)}
      >
        <option value="">すべてのAI</option>
        {options.agentLabels.map((label) => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>

      <select
        aria-label="Principal"
        className={SELECT_CLASS}
        value={filters.principalLabel ?? ""}
        onChange={(event) => set("principalLabel", event.target.value)}
      >
        <option value="">すべての依頼元</option>
        {options.principalLabels.map((label) => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>

      <select
        aria-label="SaaS"
        className={SELECT_CLASS}
        value={filters.providerLabel ?? ""}
        onChange={(event) => set("providerLabel", event.target.value)}
      >
        <option value="">すべてのSaaS</option>
        {options.providerLabels.map((label) => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>

      <select
        aria-label="Permission"
        className={SELECT_CLASS}
        value={filters.permissionEvaluation ?? ""}
        onChange={(event) => set("permissionEvaluation", event.target.value)}
      >
        <option value="">すべての権限</option>
        {PERMISSION_OPTIONS.map((status) => (
          <option key={status} value={status}>{japaneseProjection(status)}</option>
        ))}
      </select>

      <select
        aria-label="Result"
        className={SELECT_CLASS}
        value={filters.executionStatus ?? ""}
        onChange={(event) => set("executionStatus", event.target.value)}
      >
        <option value="">すべての結果</option>
        {EXECUTION_STATUS_OPTIONS.map((status) => (
          <option key={status} value={status}>{labelForExecutionStatus(status)}</option>
        ))}
      </select>

      <input
        type="date"
        aria-label="From date"
        className={SELECT_CLASS}
        value={filters.observedFrom ?? ""}
        onChange={(event) => set("observedFrom", event.target.value)}
      />

      <span className="text-[12px] text-[#8A8A8A]">〜</span>

      <input
        type="date"
        aria-label="To date"
        className={SELECT_CLASS}
        value={filters.observedTo ?? ""}
        onChange={(event) => set("observedTo", event.target.value)}
      />

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="h-9 rounded-xl px-2 text-[12px] text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
        >
          フィルタをクリア
        </button>
      )}

    </div>

  );

}
