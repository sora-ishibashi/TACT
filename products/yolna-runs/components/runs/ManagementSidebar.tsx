"use client";

import { AiIcon, ConnectionIcon, CoverageIcon, PermissionIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import type { AgentManagementItemView } from "@tact/runs-core/tact-runs-view/agentManagement";
import type { CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { PermissionScopeView } from "@tact/runs-core/tact-runs-view/permissionManagement";

export type ManagementSection = "agent" | "permission" | "connection" | "observation";

const sections = [
  { id: "agent", label: "AI", icon: AiIcon },
  { id: "permission", label: "権限", icon: PermissionIcon },
  { id: "connection", label: "接続", icon: ConnectionIcon },
  { id: "observation", label: "観測", icon: CoverageIcon },
] as const;

const itemClass = (selected: boolean) => `w-full border-l-2 px-2 py-2 text-left text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${selected ? "border-runs-interactive bg-runs-selected font-semibold text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text"}`;

export function ManagementSidebar({ section, agents, permissions, details, selectedAgentId, selectedScopeKey, selectedSurfaceId, onSectionChange, onSelectAgent, onSelectPermission, onSelectSurface }: {
  section: ManagementSection;
  agents: AgentManagementItemView[];
  permissions: PermissionScopeView[];
  details: CoverageServiceDetailView[];
  selectedAgentId: string | null;
  selectedScopeKey: string | null;
  selectedSurfaceId: string | null;
  onSectionChange: (section: ManagementSection) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPermission: (scopeKey: string) => void;
  onSelectSurface: (surfaceId: string) => void;
}) {
  return <SecondarySidebar title="管理" summary="AI・権限・接続・観測">
    <nav aria-label="管理セクション" className="grid grid-cols-2 gap-1 border-b border-runs-border-subtle pb-4">{sections.map((item) => { const Icon = item.icon; const selected = section === item.id; return <button key={item.id} type="button" aria-current={selected ? "page" : undefined} onClick={() => onSectionChange(item.id)} className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-runs-focus ${selected ? "bg-runs-selected font-semibold text-runs-text" : "text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text"}`}><Icon className="shrink-0" />{item.label}</button>; })}</nav>
    <div className="pt-4">
      {section === "agent" ? <div className="divide-y divide-runs-border-subtle">{agents.map((agent) => <button key={agent.agentId} type="button" aria-current={selectedAgentId === agent.agentId ? "page" : undefined} onClick={() => onSelectAgent(agent.agentId)} className={itemClass(selectedAgentId === agent.agentId)}><span className="block truncate font-medium" title={agent.agentId}>{agent.agentId}</span><span className="mt-1 block text-xs font-normal text-runs-muted">要確認 {agent.activeAttentionCount}件</span></button>)}</div> : null}
      {section === "permission" ? <div className="divide-y divide-runs-border-subtle">{permissions.map((scope) => <button key={scope.scopeKey} type="button" aria-current={selectedScopeKey === scope.scopeKey ? "page" : undefined} onClick={() => onSelectPermission(scope.scopeKey)} className={itemClass(selectedScopeKey === scope.scopeKey)}><span className="block truncate font-medium" title={`${scope.agentDisplayLabel} / ${scope.serviceDisplayLabel}`}>{scope.agentDisplayLabel}</span><span className="mt-1 block truncate text-xs font-normal text-runs-muted">{scope.serviceDisplayLabel}{scope.hasConflict ? " · 差分あり" : ""}</span></button>)}</div> : null}
      {section === "connection" ? <div className="divide-y divide-runs-border-subtle">{details.map((detail) => <button key={detail.surfaceId} type="button" aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined} onClick={() => onSelectSurface(detail.surfaceId)} className={itemClass(selectedSurfaceId === detail.surfaceId)}><span className="block truncate font-medium" title={detail.connection.service ?? detail.source}>{detail.connection.service ?? detail.source}</span><span className="mt-1 block truncate text-xs font-normal text-runs-muted">{detail.connection.statusLabel ?? detail.connection.unavailableMessage}</span></button>)}</div> : null}
      {section === "observation" ? <div className="divide-y divide-runs-border-subtle">{details.map((detail) => <button key={detail.surfaceId} type="button" aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined} onClick={() => onSelectSurface(detail.surfaceId)} className={itemClass(selectedSurfaceId === detail.surfaceId)}><span className="block truncate font-medium" title={detail.source}>{detail.source}</span><span className="mt-1 block text-xs font-normal text-runs-muted">{detail.classificationLabel}</span></button>)}</div> : null}
    </div>
  </SecondarySidebar>;
}
