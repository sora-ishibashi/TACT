import type { ReactNode, SVGProps } from "react";

export type RunsIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ children, ...props }: RunsIconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      {...props}
    >
      {children}
    </svg>
  );
}

const strokeProps = {
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.5,
};

export function HomeIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4Z" {...strokeProps} /></Icon>;
}

export function WorkIcon(props: RunsIconProps) {
  return <Icon {...props}><rect x="2" y="4.5" width="12" height="8.5" rx="1.5" {...strokeProps} /><path d="M5.5 4.5V3.3c0-.7.5-1.3 1.2-1.3h2.6c.7 0 1.2.6 1.2 1.3v1.2M2 8h12" {...strokeProps} /></Icon>;
}

export function AttentionIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="M8 2 14 13H2L8 2Z" {...strokeProps} /><path d="M8 6v3.2M8 11.5v.1" {...strokeProps} /></Icon>;
}

export function ActivityIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="5.5" {...strokeProps} /><path d="M8 4.8v3.5l2.3 1.4" {...strokeProps} /></Icon>;
}

export function AiIcon(props: RunsIconProps) {
  return <Icon {...props}><rect x="2.5" y="3.5" width="11" height="9" rx="2" {...strokeProps} /><path d="M8 1.5v2M5.5 7.5h.1M10.4 7.5h.1M5.5 10h5" {...strokeProps} /></Icon>;
}

export function PermissionIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="M8 1.8 13 3.7v3.6c0 3.2-2 5.6-5 6.9-3-1.3-5-3.7-5-6.9V3.7L8 1.8Z" {...strokeProps} /><path d="m5.7 8 1.5 1.5 3.2-3.2" {...strokeProps} /></Icon>;
}

export function CoverageIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="4" cy="8" r="1.5" {...strokeProps} /><circle cx="12" cy="4" r="1.5" {...strokeProps} /><circle cx="12" cy="12" r="1.5" {...strokeProps} /><path d="m5.4 7.4 5.2-2.8M5.4 8.6l5.2 2.8" {...strokeProps} /></Icon>;
}

export function SettingsIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="2.2" {...strokeProps} /><path d="M8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M12.4 3.6l-.9.9M4.5 11.5l-.9.9" {...strokeProps} /></Icon>;
}

export function CloseIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="m4 4 8 8M12 4l-8 8" {...strokeProps} strokeWidth={2} /></Icon>;
}

export function MenuIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="M2.5 4h11M2.5 8h11M2.5 12h11" {...strokeProps} /></Icon>;
}

export function DetailsIcon(props: RunsIconProps) {
  return <Icon {...props}><rect x="2" y="2.5" width="12" height="11" rx="1.5" {...strokeProps} /><path d="M9.5 2.5v11M4.5 5.5h2.2M4.5 8h2.2M4.5 10.5h2.2" {...strokeProps} /></Icon>;
}

export function ChevronRightIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="m6 3.5 4.5 4.5L6 12.5" {...strokeProps} /></Icon>;
}

export function SearchIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="7" cy="7" r="4" {...strokeProps} /><path d="m10 10 3.2 3.2" {...strokeProps} /></Icon>;
}

export function ClearIcon(props: RunsIconProps) {
  return <CloseIcon {...props} />;
}

export function CheckCircleIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="5.5" {...strokeProps} /><path d="m5.2 8.1 1.8 1.8 3.8-3.8" {...strokeProps} /></Icon>;
}

export function XCircleIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="5.5" {...strokeProps} /><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" {...strokeProps} /></Icon>;
}

export function RunningIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="4.5" fill="currentColor" /></Icon>;
}

export function ObservedIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="4.5" {...strokeProps} /></Icon>;
}

export function CancelledIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="5.5" {...strokeProps} /><path d="m4.2 11.8 7.6-7.6" {...strokeProps} /></Icon>;
}

export function UnknownIcon(props: RunsIconProps) {
  return <Icon {...props}><circle cx="8" cy="8" r="5.5" {...strokeProps} /><path d="M6.4 6.2A1.7 1.7 0 0 1 8.1 4.8c1 0 1.8.6 1.8 1.6 0 1.3-1.9 1.5-1.9 3M8 11.5v.1" {...strokeProps} /></Icon>;
}

export function WarningIcon(props: RunsIconProps) {
  return <Icon {...props}><path d="M8 2 14 13H2L8 2Z" {...strokeProps} /><path d="M8 6v3M8 11v.1" {...strokeProps} /></Icon>;
}
