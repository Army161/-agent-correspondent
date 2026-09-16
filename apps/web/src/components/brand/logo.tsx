/**
 * The Agent Correspondent mark, inline.
 *
 * Inline rather than an `<img>` so it inherits colour, never flashes and can be
 * sized freely. The geometry matches `/public/logo-mark.svg` exactly.
 *
 * The cyan gradient uses `userSpaceOnUse`: an object-bounding-box gradient is
 * undefined on a zero-area box, which silently drops the antennae and the side
 * ticks (they are straight lines).
 */

export function LogoMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}): React.JSX.Element {
  const gradientId = `acorCyan-${size}`;
  const nodeId = `acorNode-${size}`;
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Agent Correspondent"
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="15" y1="28" x2="113" y2="86">
          <stop offset="0" stopColor="#00E5FF" />
          <stop offset="1" stopColor="#00CFCF" />
        </linearGradient>
        <radialGradient id={nodeId} gradientUnits="userSpaceOnUse" cx="64" cy="63.5" r="24">
          <stop offset="0" stopColor="#F7FBFF" />
          <stop offset="0.4" stopColor="#00E5FF" />
          <stop offset="1" stopColor="#00E5FF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="3.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <rect x="15" y="41" width="35" height="45" rx="10" />
        <path d="M32.5 41 v-9" />
        <circle cx="32.5" cy="28.5" r="3.4" fill={`url(#${gradientId})`} stroke="none" />
        <path d="M15 57 h-6" />
        <path d="M15 70 h-6" />
        <rect x="78" y="41" width="35" height="45" rx="10" />
        <path d="M95.5 41 v-9" />
        <circle cx="95.5" cy="28.5" r="3.4" fill={`url(#${gradientId})`} stroke="none" />
        <path d="M113 57 h6" />
        <path d="M113 70 h6" />
      </g>
      <g fill="#F7FBFF">
        <rect x="23.5" y="56" width="18" height="5" rx="2.5" />
        <rect x="86.5" y="56" width="18" height="5" rx="2.5" />
      </g>
      <g fill="#8EA3B3" opacity="0.75">
        <rect x="26.5" y="71" width="12" height="3" rx="1.5" />
        <rect x="89.5" y="71" width="12" height="3" rx="1.5" />
      </g>
      <path
        d="M50 63.5 h28"
        stroke="#00E5FF"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.5"
        strokeDasharray="3 4"
      />
      <circle cx="64" cy="63.5" r="24" fill={`url(#${nodeId})`} opacity="0.5" />
      <circle cx="64" cy="63.5" r="14.5" fill="#03070B" stroke="#00E5FF" strokeWidth="2.8" />
      <path d="M64 54 v19" stroke="#F7FBFF" strokeWidth="2.4" strokeLinecap="round" />
      <path
        d="M68.6 58.2 a4.6 4.6 0 0 0 -4.6 -2.9 h-0.7 a4 4 0 0 0 0 8 h1.8 a4 4 0 0 1 0 8 h-0.7 a4.6 4.6 0 0 1 -4.6 -2.9"
        fill="none"
        stroke="#F7FBFF"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({
  size = 32,
  subtitle = true,
}: {
  size?: number;
  subtitle?: boolean;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="flex flex-col leading-none">
        <span
          className="font-semibold tracking-[0.18em] text-[var(--color-bright)]"
          style={{ fontSize: size * 0.5 }}
        >
          ACOR
        </span>
        {subtitle ? (
          <span
            className="mt-1 font-medium tracking-[0.14em] text-[var(--color-subtle)]"
            style={{ fontSize: size * 0.26 }}
          >
            AGENT CORRESPONDENT
          </span>
        ) : null}
      </span>
    </span>
  );
}
