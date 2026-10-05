"use client";

// =========================
// PermissionSidebar (SOR-187)
// =========================
//
// 検索・すべて・AI別・サービス別・要確認ありのfilterと、AI x Service
// scopeのselectable listを提供する。filter判定・count導出は一切ここに
// 無い——core/tact-runs-view/permissionManagement.tsのpure関数へ完全
// 委譲する(絶対条件「No business logic in React」、WorkSidebar.tsxと
// 同じ既存規律)。

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import {
  filterPermissionScopes,
  summarizePermissionScopesByAgent,
  summarizePermissionScopesByService,
  type PermissionScopeView,
} from "@tact/runs-core/tact-runs-view/permissionManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter =
  | { kind: "all" }
  | { kind: "needs_confirmation" }
  | { kind: "agent"; agentId: string | null }
  | { kind: "service"; service: ExecutionProvider | null };

export function PermissionSidebar({ scopes, state, selectedScopeKey, onSelect }: {
  scopes: PermissionScopeView[];
  state: PresentationStateKind | null;
  selectedScopeKey: string | null;
  onSelect: (scopeKey: string) => void;
}) {

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });

  const agentOptions = useMemo(() => summarizePermissionScopesByAgent(scopes), [scopes]);
  const serviceOptions = useMemo(() => summarizePermissionScopesByService(scopes), [scopes]);
  const needsConfirmationCount = useMemo(() => scopes.filter((scope) => scope.hasConflict).length, [scopes]);

  const visible = useMemo(() => filterPermissionScopes(scopes, {
    search,
    needsConfirmationOnly: category.kind === "needs_confirmation",
    agentId: category.kind === "agent" ? category.agentId : undefined,
    service: category.kind === "service" ? category.service : undefined,
  }), [scopes, search, category]);

  return (
    <SecondarySidebar title="権限" summary={state ? undefined : `表示中 ${visible.length} 件`}>
      {state ? <PresentationState kind={state} /> : <>

        <input
          aria-label="権限を検索"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="AI・サービスで検索"
          className="mb-3 h-9 w-full rounded border border-[#D9D9D9] px-2 text-[12px]"
        />

        <div className="mb-3 flex flex-wrap gap-1 text-[12px]">
          <button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className="rounded px-2 py-1 text-[#112278]">
            すべて ({scopes.length})
          </button>
          <button type="button" onClick={() => setCategory({ kind: "needs_confirmation" })} aria-pressed={category.kind === "needs_confirmation"} className="rounded px-2 py-1 text-[#112278]">
            要確認あり ({needsConfirmationCount})
          </button>
        </div>

        {agentOptions.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-[11px] text-[#8A8A8A]">AI別</p>
            <div className="flex flex-col gap-1">
              {agentOptions.map((option) => (
                <button
                  key={option.agentId ?? "unspecified"}
                  type="button"
                  onClick={() => setCategory({ kind: "agent", agentId: option.agentId })}
                  aria-pressed={category.kind === "agent" && category.agentId === option.agentId}
                  className="rounded px-2 py-1 text-left text-[12px] text-[#112278]"
                >
                  {option.label} ({option.count})
                </button>
              ))}
            </div>
          </div>
        )}

        {serviceOptions.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-[11px] text-[#8A8A8A]">サービス別</p>
            <div className="flex flex-col gap-1">
              {serviceOptions.map((option) => (
                <button
                  key={option.service ?? "unspecified"}
                  type="button"
                  onClick={() => setCategory({ kind: "service", service: option.service })}
                  aria-pressed={category.kind === "service" && category.service === option.service}
                  className="rounded px-2 py-1 text-left text-[12px] text-[#112278]"
                >
                  {option.label} ({option.count})
                </button>
              ))}
            </div>
          </div>
        )}

        {visible.length === 0 ? <PresentationState kind="empty" /> : (
          <div className="flex flex-col gap-1">
            {visible.map((scope) => (
              <button
                key={scope.scopeKey}
                type="button"
                onClick={() => onSelect(scope.scopeKey)}
                aria-current={selectedScopeKey === scope.scopeKey ? "page" : undefined}
                className={`rounded px-2 py-2 text-left text-[12px] ${selectedScopeKey === scope.scopeKey ? "bg-[#E6F2F2] text-[#112278]" : "text-[#626161] hover:bg-[#F2F2F2]"}`}
              >
                <span className="block truncate font-medium">{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</span>
                <span className="mt-1 block text-[11px]">{scope.hasConflict ? "要確認あり" : `登録ルール ${scope.registeredRules.length}件`}</span>
              </button>
            ))}
          </div>
        )}

      </>}
    </SecondarySidebar>
  );

}
