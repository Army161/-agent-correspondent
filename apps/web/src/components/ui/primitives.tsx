/**
 * The Agent Correspondent UI kit.
 *
 * Small, composable, shadcn-shaped primitives built directly on Tailwind and
 * the brand tokens in `globals.css`. They are deliberately plain: the interest
 * in this product belongs in the numbers, not in the chrome around them.
 */

import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Panel({
  className,
  children,
  ...props
}: ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--color-bright)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-cyan)] text-[#03070B] hover:bg-[#3aecff] font-semibold",
        secondary:
          "border border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-bright)] hover:border-[#1d4b5b] hover:bg-[#0d1e28]",
        ghost: "text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-bright)]",
        danger: "border border-[#4a1f28] bg-[#1a0b0f] text-[var(--color-danger)] hover:bg-[#240f14]",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-[15px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonStyles>;

export function Button({ className, variant, size, ...props }: ButtonProps): React.JSX.Element {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

export function ButtonLink({
  className,
  variant,
  size,
  ...props
}: ComponentProps<typeof Link> & VariantProps<typeof buttonStyles>): React.JSX.Element {
  return <Link className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Badges and status
// ---------------------------------------------------------------------------

const badgeStyles = cva(
  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        neutral: "bg-[#0d1e28] text-[var(--color-muted)] border border-[var(--color-border)]",
        cyan: "bg-[rgba(0,229,255,0.1)] text-[var(--color-cyan)] border border-[rgba(0,229,255,0.28)]",
        success: "bg-[rgba(55,230,161,0.1)] text-[var(--color-success)] border border-[rgba(55,230,161,0.28)]",
        warning: "bg-[rgba(255,184,77,0.1)] text-[var(--color-warning)] border border-[rgba(255,184,77,0.3)]",
        danger: "bg-[rgba(255,92,112,0.1)] text-[var(--color-danger)] border border-[rgba(255,92,112,0.3)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeStyles>;

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />;
}

/** Maps a capability/adapter/job state to a consistent colour across the app. */
export function stateTone(state: string): "neutral" | "cyan" | "success" | "warning" | "danger" {
  switch (state.toUpperCase()) {
    case "AVAILABLE":
    case "READY":
    case "CONNECTED":
    case "COMPLETE":
    case "SETTLED":
    case "CONFIRMED":
    case "PASS":
    case "ALLOW":
      return "success";
    case "EXPERIMENTAL":
    case "TESTNET_ONLY":
    case "DEGRADED":
    case "PENDING":
    case "EVALUATING":
    case "SUBMITTED":
    case "REQUIRE_HUMAN_APPROVAL":
      return "warning";
    case "DISABLED":
    case "ERROR":
    case "FAILED":
    case "REJECTED":
    case "DISPUTED":
    case "DENY":
      return "danger";
    case "IN_PROGRESS":
    case "FUNDED":
    case "OPEN":
      return "cyan";
    default:
      return "neutral";
  }
}

export function StatusDot({ tone }: { tone: ReturnType<typeof stateTone> }): React.JSX.Element {
  const colors: Record<string, string> = {
    neutral: "bg-[var(--color-subtle)]",
    cyan: "bg-[var(--color-cyan)]",
    success: "bg-[var(--color-success)]",
    warning: "bg-[var(--color-warning)]",
    danger: "bg-[var(--color-danger)]",
  };
  return <span className={cn("size-1.5 rounded-full", colors[tone])} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "muted" | "cyan";
}): React.JSX.Element {
  return (
    <div className="px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "tabular mt-2 text-[22px] leading-none",
          tone === "muted" && "text-[var(--color-muted)] text-[15px]",
          tone === "cyan" && "text-[var(--color-cyan)]",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-2 text-[12px] text-[var(--color-subtle)]">{hint}</div> : null}
    </div>
  );
}

export function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-[12px] uppercase tracking-[0.1em] text-[var(--color-subtle)]">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right text-[13px] text-[var(--color-bright)]",
          mono && "tabular",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The honest empty state.
 *
 * Used everywhere the platform has no data: it names the reason and, where
 * there is one, the exact thing an operator must configure. It never renders a
 * zero in place of an unknown.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-subtle)]">
        {title}
      </div>
      {description ? (
        <p className="max-w-md text-[13px] leading-relaxed text-[var(--color-muted)]">
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <code className="tabular rounded bg-[var(--color-elevated)] px-1.5 py-0.5 text-[12px] text-[var(--color-cyan)]">
      {children}
    </code>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">): React.JSX.Element {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-bright)] placeholder:text-[var(--color-subtle)] focus:border-[rgba(0,229,255,0.4)] focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm text-[var(--color-bright)] placeholder:text-[var(--color-subtle)] focus:border-[rgba(0,229,255,0.4)] focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">): React.JSX.Element {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-bright)] focus:border-[rgba(0,229,255,0.4)] focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">): React.JSX.Element {
  return (
    <label
      className={cn(
        "mb-1.5 block text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--color-subtle)]",
        className,
      )}
      {...props}
    />
  );
}

export function Divider({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn("h-px w-full bg-[var(--color-border)]", className)} />;
}
