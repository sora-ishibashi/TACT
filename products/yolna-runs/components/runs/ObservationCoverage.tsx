import type { CaptureGap, ObservationSurface } from "@tact/runs-core/tact-execution";
import { Badge } from "./badges";

function formatDate(value: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not seen"; }
function tone(value: string): "success" | "error" | "warning" | "muted" { return value === "HEALTHY" || value === "COVERED" ? "success" : value === "UNKNOWN" ? "muted" : value === "PARTIAL" || value === "DEGRADED" ? "warning" : "error"; }

export default function ObservationCoverage({ surfaces, gaps }: { surfaces: ObservationSurface[]; gaps: CaptureGap[] }) {
  const currentGap = new Map<string, CaptureGap>();
  for (const gap of gaps) if (gap.status !== "RESOLVED" && !currentGap.has(gap.observationSurfaceId)) currentGap.set(gap.observationSurfaceId, gap);
  return <section aria-labelledby="observation-coverage-heading" className="mt-6 border border-[#D9D9D9] bg-white p-4">
    <div className="flex items-baseline justify-between gap-3"><h2 id="observation-coverage-heading" className="text-[13px] font-medium leading-[18px] text-[#112278]">Observation Coverage</h2><span className="text-[12px] text-[#626161]">Coverage is not execution success</span></div>
    {surfaces.length === 0 ? <p className="mt-3 text-[13px] leading-[18px] text-[#626161]">No observation surfaces are registered. Coverage remains unknown.</p> : <div className="mt-3 overflow-x-auto"><table className="min-w-full text-left text-[12px] leading-[16px]"><thead className="border-b border-[#D9D9D9] text-[#626161]"><tr><th className="pb-2 pr-4 font-medium">Source</th><th className="pb-2 pr-4 font-medium">Health</th><th className="pb-2 pr-4 font-medium">Coverage</th><th className="pb-2 pr-4 font-medium">Last seen</th><th className="pb-2 font-medium">Current gap</th></tr></thead><tbody>{surfaces.map((surface) => { const gap = currentGap.get(surface.surfaceId); return <tr key={surface.surfaceId} className="border-b border-[#D9D9D9]/70"><td className="py-2 pr-4 text-[#112278]">{surface.source}</td><td className="py-2 pr-4"><Badge label={surface.health} tone={tone(surface.health)} /></td><td className="py-2 pr-4"><Badge label={surface.coverageStatus} tone={tone(surface.coverageStatus)} /></td><td className="py-2 pr-4 text-[#626161]">{formatDate(surface.lastSeenAt)}</td><td className="py-2 text-[#626161]">{gap ? gap.reason : "None"}</td></tr>; })}</tbody></table></div>}
  </section>;
}
