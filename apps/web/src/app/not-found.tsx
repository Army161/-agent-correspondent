import Link from "next/link";

import { LogoMark } from "@/components/brand/logo";
import { ButtonLink } from "@/components/ui/primitives";

export default function NotFound(): React.JSX.Element {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <Link href="/">
        <LogoMark size={56} />
      </Link>
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Route not found</h1>
        <p className="mt-2 text-[14px] text-[var(--color-muted)]">
          That page does not exist in the Agent OS.
        </p>
      </div>
      <ButtonLink href="/" variant="primary">
        Back to Agent Correspondent
      </ButtonLink>
    </main>
  );
}
