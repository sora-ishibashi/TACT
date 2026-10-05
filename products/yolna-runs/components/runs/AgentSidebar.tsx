"use client";

// =========================
// AgentSidebar (SOR-186: Observed AI Management)
// =========================
//
// 検索・すべて・実行記録あり・権限設定あり・操作/観測されたサービス別の
// filterと、AI識別子のselectable listを提供する。filter判定・count導出
// は一切ここに無い——core/tact-runs-view/agentManagement.tsのpure関数へ
// 完全委譲する(絶対条件「No business logic in React」、PermissionSidebar.tsx
// と同じ既存規律)。
//
// 絶対条件(SOR-186指示): 登録済み/無効/未登録/provider別のfilterは
// canonical sourceが無いため使わない。表示名を捏造しない——agentIdその
// ものを主表示にする(label「AI識別子」で意味を明示)。

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import {
  filterAgentManagementItems,
  summarizeAgentManagementByTargetSystem,
  summarizeAgentManagementEvidence,
  type AgentIdentityEvidence,
  type AgentManagementItemView,
} from "@tact/runs-core/tact-runs-view/agentManagement";

type CategoryFilter =
  | { kind: "all" }
  | { kind: "evidence"; evidence: AgentIdentityEvidence }
  | { kind: "target_system"; label: string };

function evidenceJapanese(evidence: AgentIdentityEvidence): string {
  switch (evidence) {
    case "execution_observed": return "実行記録あり";
    case "permission_scoped": return "権限設定あり";
  }
}

function formatLastActivity(value: string | null): string {
  if (!value) return "実行記録がありません";
  try {
    return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return value;
  }
}

export function AgentSidebar({ items, state, selectedAgentId, onSelect }: {
  items: AgentManagementItemView[];
  state: PresentationStateKind | null;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}) {

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });

  const targetSystemOptions = useMemo(() => summarizeAgentManagementByTargetSystem(items), [items]);
  const evidenceSummary = useMemo(() => summarizeAgentManagementEvidence(items), [items]);

  const visible = useMemo(() => filterAgentManagementItems(items, {
    search,
    evidence: category.kind === "evidence" ? category.evidence : undefined,
    targetSystemLabel: category.kind === "target_system" ? category.label : undefined,
  }), [items, search, category]);

  return (
    <SecondarySidebar title="AI" summary={state ? undefined : `表示中 ${visible.length} 件`}>
      {state ? <PresentationState kind={state} /> : <>

        <input
          aria-label="AI識別子を検索"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="AI識別子で検索"
          className="mb-3 h-9 w-full rounded border border-[#D9D9D9] px-2 text-[12px]"
        />

        <div className="mb-3 flex flex-wrap gap-1 text-[12px]">
          <button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className="rounded px-2 py-1 text-[#112278]">
            すべて ({items.length})
          </button>
          <button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "execution_observed" })} aria-pressed={category.kind === "evidence" && category.evidence === "execution_observed"} className="rounded px-2 py-1 text-[#112278]">
            実行記録あり ({evidenceSummary.executionObservedCount})
          </button>
          <button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "permission_scoped" })} aria-pressed={category.kind === "evidence" && category.evidence === "permission_scoped"} className="rounded px-2 py-1 text-[#112278]">
            権限設定あり ({evidenceSummary.permissionScopedCount})
          </button>
        </div>

        {targetSystemOptions.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-[11px] text-[#8A8A8A]">操作・観測されたサービス別</p>
            <div className="flex flex-col gap-1">
              {targetSystemOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setCategory({ kind: "target_system", label: option.label })}
                  aria-pressed={category.kind === "target_system" && category.label === option.label}
                  className="rounded px-2 py-1 text-left text-[12px] text-[#112278]"
                >
                  {option.label} ({option.count})
                </button>
              ))}
            </div>
          </div>
        )}

        {visible.length === 0 ? (
          <PresentationState kind="empty">
            AIとして識別できる実行記録・権限設定はまだありません。
          </PresentationState>
        ) : (
          <div className="flex flex-col gap-1">
            {visible.map((item) => (
              <button
                key={item.agentId}
                type="button"
                onClick={() => onSelect(item.agentId)}
                aria-current={selectedAgentId === item.agentId ? "page" : undefined}
                className={`rounded px-2 py-2 text-left text-[12px] ${selectedAgentId === item.agentId ? "bg-[#E6F2F2] text-[#112278]" : "text-[#626161] hover:bg-[#F2F2F2]"}`}
              >
                <span className="block truncate font-medium">{item.agentId}</span>
                <span className="mt-1 block text-[11px]">
                  {item.identityEvidence.map(evidenceJapanese).join(" / ")}
                  {item.activeAttentionCount > 0 ? ` ・ 要確認 ${item.activeAttentionCount}件` : ""}
                </span>
                <span className="mt-0.5 block text-[11px] text-[#8A8A8A]">{formatLastActivity(item.lastActivityAt)}</span>
              </button>
            ))}
          </div>
        )}

      </>}
    </SecondarySidebar>
  );

}
