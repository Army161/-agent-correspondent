import Link from "next/link";

import { LogoMark } from "@/components/brand/logo";

export default function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark size={26} />
            <span className="text-[13px] font-semibold tracking-[0.16em]">
              AGENT CORRESPONDENT
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">{children}</main>
    </div>
  );
}
