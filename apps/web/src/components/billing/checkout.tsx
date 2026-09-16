"use client";

/**
 * Paddle checkout.
 *
 * The button asks *our* server to create the transaction, then opens Paddle's
 * overlay for it. The browser never chooses which organization is being billed
 * — that is fixed in the transaction's custom data, server-side — and reaching
 * the success state grants nothing. The plan arrives when Paddle's signed
 * webhook does.
 */

import Script from "next/script";
import { useState } from "react";

import { Button } from "@/components/ui/primitives";

interface PaddleGlobal {
  Environment?: { set(environment: string): void };
  Initialize(options: { token: string }): void;
  Checkout: { open(options: { transactionId: string }): void };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

export function CheckoutButton({
  planId,
  planName,
  period,
  clientToken,
  environment,
  disabledReason,
}: {
  planId: string;
  planName: string;
  period: "monthly" | "yearly";
  clientToken: string | null;
  environment: "sandbox" | "production";
  disabledReason: string | null;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const blocked = disabledReason ?? (clientToken === null ? "Checkout is not configured." : null);

  async function start(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId, period }),
      });
      const body = (await response.json()) as { transactionId?: string; error?: string };
      if (!response.ok || !body.transactionId) {
        setError(body.error ?? "Could not start checkout.");
        return;
      }
      const paddle = window.Paddle;
      if (!paddle) {
        setError("The checkout script did not load.");
        return;
      }
      paddle.Checkout.open({ transactionId: body.transactionId });
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {clientToken ? (
        <Script
          src="https://cdn.paddle.com/paddle/v2/paddle.js"
          strategy="afterInteractive"
          onReady={() => {
            const paddle = window.Paddle;
            if (!paddle) return;
            if (environment === "sandbox") paddle.Environment?.set("sandbox");
            paddle.Initialize({ token: clientToken });
            setReady(true);
          }}
        />
      ) : null}

      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={blocked !== null || busy || !ready}
        onClick={() => void start()}
      >
        {busy ? "Opening…" : `Upgrade to ${planName}`}
      </Button>

      {blocked ? (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-subtle)]">{blocked}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[12px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
