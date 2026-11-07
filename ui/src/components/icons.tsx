import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 5.75v-1.5a1.5 1.5 0 0 0-1.5-1.5h-4.5a1.5 1.5 0 0 0-1.5 1.5v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path d="m10.5 10.5 3 3" />
    </Icon>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5h6v6" />
      <path d="m11.5 4.5-7 7" />
    </Icon>
  );
}

export function ArrowDownLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 11.5h-6v-6" />
      <path d="m4.5 11.5 7-7" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10" />
      <path d="m4 9 4 4 4-4" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </Icon>
  );
}

export function RailIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
    </Icon>
  );
}

export function ConsoleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <rect x="4.5" y="5" width="2.5" height="6" rx="0.75" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function WindowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <path d="M2.25 6h11.5" />
      <path d="M4.6 4.4h.01M6.3 4.4h.01" />
    </Icon>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 4.5C6.7 3.5 5 3 2.75 3v9.5c2.25 0 3.95.5 5.25 1.5 1.3-1 3-1.5 5.25-1.5V3C11 3 9.3 3.5 8 4.5Z" />
      <path d="M8 4.5V14" />
    </Icon>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.75" r="1.25" />
      <circle cx="4.5" cy="12.25" r="1.25" />
      <circle cx="11.5" cy="5.25" r="1.25" />
      <path d="M4.5 5v6" />
      <path d="M11.5 6.5c0 2.5-2.5 3-7 4.5" />
    </Icon>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <path d="m5 6.5 1.75 1.5L5 9.5" />
      <path d="M8.5 9.5H11" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.13 3.25a1 1 0 0 1 1.74 0l5.06 8.75a1 1 0 0 1-.87 1.5H2.94a1 1 0 0 1-.87-1.5l5.06-8.75Z" />
      <path d="M8 6.75v2.5" />
      <path d="M8 11.25h.01" />
    </Icon>
  );
}

export function XCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="m6 6 4 4M10 6l-4 4" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25Z" />
    </Icon>
  );
}

export function PointerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 2.75 9 4-3.9 1.35L7.25 12 3.5 2.75Z" />
    </Icon>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5.5 5-3 3 3 3" />
      <path d="m10.5 5 3 3-3 3" />
    </Icon>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 8h2.5L6 4l4 8 1.5-4H14" />
    </Icon>
  );
}

export function ToolstackLogo(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m4 10 12-6 12 6-12 6-12-6Z" />
      <path d="m4 16 12 6 12-6M4 22l12 6 12-6" />
    </svg>
  );
}
