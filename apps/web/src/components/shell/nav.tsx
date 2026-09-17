"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  Bot,
  Briefcase,
  Code2,
  Coins,
  CreditCard,
  LayoutGrid,
  Lock,
  MessageSquare,
  Scale,
  Settings,
  Shield,
  Wallet,
} from "lucide-react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { LogoMark } from "@/components/brand/logo";
import { cn } from "@/lib/cn";

const PRIMARY = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/clearing", label: "Clearing", icon: Scale },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/developers", label: "Developers", icon: Code2 },
  { href: "/acor", label: "ACOR", icon: Coins },
] as const;

const SECONDARY = [
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings/security", label: "Account security", icon: Lock },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/security", label: "Platform security", icon: Shield },
] as const;

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: typeof MessageSquare;
  active: boolean;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-[rgba(0,229,255,0.09)] text-[var(--color-cyan)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-bright)]",
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
      {label}
    </Link>
  );
}

export function AppNav({ userEmail }: { userEmail?: string | null }): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The longest match wins, so /settings does not light up while the user is
  // on /settings/security.
  const matches = (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);
  const best = [...PRIMARY, ...SECONDARY]
    .map((item) => item.href)
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const isActive = (href: string): boolean => href === best;

  const body = (
    <>
      <nav className="flex flex-col gap-0.5 px-3" aria-label="Primary">
        {PRIMARY.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            active={isActive(item.href)}
            onNavigate={() => setOpen(false)}
          />
        ))}
      </nav>
      <div className="mt-6 px-3">
        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-subtle)]">
          Account
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Secondary">
          {SECONDARY.map((item) => (
            <NavLink
              key={item.href}
              {...item}
              active={isActive(item.href)}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </nav>
        <div className="px-3 pt-4">
          <div className="truncate text-[11px] text-[var(--color-subtle)]">
            {userEmail ?? "Not signed in"}
          </div>
          {userEmail ? <SignOutButton /> : null}
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile bar */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-4 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark size={26} />
          <span className="text-[13px] font-semibold tracking-[0.16em]">ACOR</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label="Toggle navigation"
          className="rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-muted)]"
        >
          <LayoutGrid className="size-4" strokeWidth={1.8} />
        </button>
      </header>

      {open ? (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-background)] py-4 lg:hidden">
          {body}
        </div>
      ) : null}

      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-background)] py-5 lg:flex">
        <Link href="/" className="mb-6 flex items-center gap-2.5 px-6">
          <LogoMark size={30} />
          <span className="flex flex-col leading-none">
            <span className="text-[14px] font-semibold tracking-[0.18em]">ACOR</span>
            <span className="mt-1 text-[9px] font-medium tracking-[0.14em] text-[var(--color-subtle)]">
              AGENT CORRESPONDENT
            </span>
          </span>
        </Link>
        {body}
      </aside>
    </>
  );
}
