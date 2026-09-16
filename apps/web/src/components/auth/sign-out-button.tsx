"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";

/**
 * Sign out.
 *
 * Revokes the session server-side rather than only clearing the cookie: a
 * cookie the browser forgets is a cookie an attacker may still hold.
 */
export function SignOutButton(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void authClient.signOut().finally(() => {
          router.push("/login");
          router.refresh();
        });
      }}
      className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-subtle)] hover:text-[var(--color-bright)] disabled:opacity-50"
    >
      <LogOut className="size-3" strokeWidth={1.8} aria-hidden />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
