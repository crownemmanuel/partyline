// Small stroke icons (24×24, currentColor) for the crew screen; matches the native apps' SF Symbols.
type P = { className?: string };
const Svg = ({ className = "h-6 w-6", children }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {children}
  </svg>
);

export const MicIcon = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
  </Svg>
);
export const MicOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5 2.2M19 10a7 7 0 0 1-1.3 4M5 10a7 7 0 0 0 11.2 5.6M12 17v4M8 21h8M3 3l18 18" />
  </Svg>
);
export const SpeakerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
);
export const SpeakerOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </Svg>
);
export const WaveIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 6v12" />
  </Svg>
);
export const ReplyIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 17 4 12l5-5" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </Svg>
);
export const GearIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
export const SparklesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z" />
  </Svg>
);
export const ChatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.5A8 8 0 1 1 21 12z" />
  </Svg>
);
export const BellIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);
export const ExpandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
);
export const RefreshIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5" />
  </Svg>
);
export const UnlockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.8-1.2" />
  </Svg>
);
export const LayersIcon = (p: P) => (
  <Svg {...p}>
    <path d="m12 2 10 5-10 5L2 7z" />
    <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
  </Svg>
);
export const MegaphoneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 11v3a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z" />
    <path d="M17 9a4 4 0 0 1 0 6M7 15l1 5h3l-1-4.3" />
  </Svg>
);
export const HeadphonesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
  </Svg>
);
export const TargetIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Svg>
);
export const BatteryIcon = ({ level, charging, ...p }: P & { level: number; charging?: boolean }) => (
  <Svg {...p}>
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <path d="M22 11v2" />
    <rect x="4" y="9" width={Math.max(1, Math.round((13 * level) / 100))} height="6" rx="1" fill="currentColor" stroke="none" />
    {charging && <path d="m11 8-2 4h3l-2 4" strokeWidth={1.6} />}
  </Svg>
);
export const SignalIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16" />
  </Svg>
);
export const PowerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" />
  </Svg>
);
export const XIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const ChevronUpIcon = (p: P) => (
  <Svg {...p}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
);
export const ChevronDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const PhoneIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </Svg>
);
