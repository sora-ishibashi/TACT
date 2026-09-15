export type ServiceName = "slack" | "gmail" | "notion" | "google-calendar";

type ServicePresentation = { label: string; mark: string };

const SERVICE_PRESENTATION: Record<ServiceName, ServicePresentation> = {
  slack: { label: "Slack", mark: "S" },
  gmail: { label: "Gmail", mark: "G" },
  notion: { label: "Notion", mark: "N" },
  "google-calendar": { label: "Google Calendar", mark: "C" },
};

export function serviceLabel(service: ServiceName): string {
  return SERVICE_PRESENTATION[service].label;
}

export default function ServiceBadge({ service, compact = false }: { service: ServiceName; compact?: boolean }) {
  const presentation = SERVICE_PRESENTATION[service];

  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium leading-4 text-[#112278]">
      <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#E6F2F2] text-[10px] font-medium text-[#172E95]">
        {presentation.mark}
      </span>
      {!compact && <span>{presentation.label}</span>}
      <span className="sr-only">{presentation.label}</span>
    </span>
  );
}

export function ServiceIconList({ services }: { services: readonly ServiceName[] }) {
  return (
    <span className="flex flex-wrap items-center gap-2" aria-label={`使用サービス: ${services.map(serviceLabel).join("、")}`}>
      {services.map((service) => <ServiceBadge key={service} service={service} />)}
    </span>
  );
}
