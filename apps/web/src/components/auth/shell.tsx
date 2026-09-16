import Link from "next/link";

import { LogoMark } from "@/components/brand/logo";
import { Panel } from "@/components/ui/primitives";

/** The frame every unauthenticated auth page shares. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex flex-col items-center gap-3">
          <LogoMark size={48} />
          <span className="text-[13px] font-semibold tracking-[0.2em] text-[var(--color-muted)]">
            AGENT CORRESPONDENT
          </span>
        </Link>
        <Panel className="p-6">
          <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
            {description}
          </p>
          {children}
        </Panel>
      </div>
    </main>
  );
}
