"use client";

/**
 * Connect a wallet, and prove it.
 *
 * Three steps, all of them visible to the user: ask the browser wallet which
 * address it holds, ask this server for a challenge naming that address and
 * that agent, and have the wallet sign it.
 *
 * The signature is `personal_sign` over a human-readable message. It authorizes
 * nothing and moves nothing — it is only evidence that whoever is connecting
 * holds the key. The server re-derives the address from the signature; this
 * component's claim about which address it connected is not trusted.
 */

import { useState } from "react";

import { Button, Select } from "@/components/ui/primitives";

/** The minimum of EIP-1193 this flow needs. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface ConnectableAgent {
  readonly id: string;
  readonly name: string;
}

type Stage = "idle" | "connecting" | "signing" | "binding" | "done";

export function ConnectWallet({
  agents,
  networks,
  walletConnectAvailable,
}: {
  agents: readonly ConnectableAgent[];
  networks: readonly string[];
  walletConnectAvailable: boolean;
}): React.JSX.Element {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [network, setNetwork] = useState(networks[0] ?? "ARC");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <p className="px-5 py-4 text-[13px] text-[var(--color-muted)]">
        Create an agent first. A wallet is bound to an agent, not to an account.
      </p>
    );
  }

  async function connect(): Promise<void> {
    setError(null);
    setBound(null);

    const injected = typeof window === "undefined" ? undefined : window.ethereum;
    if (!injected) {
      setError(
        walletConnectAvailable
          ? "No browser wallet was found. Install one, or scan with WalletConnect."
          : "No browser wallet was found in this browser. Install one to continue — WalletConnect is not configured on this deployment.",
      );
      return;
    }

    try {
      setStage("connecting");
      const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) {
        setError("The wallet did not return an address.");
        setStage("idle");
        return;
      }

      const challengeResponse = await fetch(`/api/v1/agents/${agentId}/wallets/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, address }),
      });
      const challenge = (await challengeResponse.json()) as {
        nonce?: string;
        message?: string;
        error?: string;
      };
      if (!challengeResponse.ok || !challenge.nonce || !challenge.message) {
        setError(challenge.error ?? "Could not get a challenge from the server.");
        setStage("idle");
        return;
      }

      setStage("signing");
      const signature = (await injected.request({
        method: "personal_sign",
        params: [challenge.message, address],
      })) as string;

      setStage("binding");
      const bindResponse = await fetch(`/api/v1/agents/${agentId}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network,
          address,
          custody: "external",
          isPrimary: true,
          nonce: challenge.nonce,
          signature,
        }),
      });
      const result = (await bindResponse.json()) as { error?: string; message?: string };
      if (!bindResponse.ok) {
        setError(result.message ?? result.error ?? "The proof was not accepted.");
        setStage("idle");
        return;
      }

      setBound(address.toLowerCase());
      setStage("done");
    } catch (cause) {
      // A dismissed wallet prompt throws. That is a choice, not a failure.
      setError(
        cause instanceof Error && /reject|denied/i.test(cause.message)
          ? "The wallet prompt was dismissed."
          : "The wallet could not complete the request.",
      );
      setStage("idle");
    }
  }

  const busy = stage === "connecting" || stage === "signing" || stage === "binding";

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--color-subtle)]">
            Agent
          </span>
          <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--color-subtle)]">
            Network
          </span>
          <Select value={network} onChange={(event) => setNetwork(event.target.value)}>
            {networks.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={() => void connect()}
      >
        {stage === "connecting"
          ? "Waiting for the wallet…"
          : stage === "signing"
            ? "Sign the message in your wallet…"
            : stage === "binding"
              ? "Verifying…"
              : "Connect a wallet"}
      </Button>

      <p className="text-[11px] leading-relaxed text-[var(--color-subtle)]">
        You will be asked to sign a message. It is not a transaction: it authorizes nothing and
        moves no funds. This platform never asks for a seed phrase or a private key, and has
        nowhere to store one.
        {walletConnectAvailable
          ? null
          : " WalletConnect is not configured on this deployment, so only a browser-injected wallet can be used."}
      </p>

      {bound ? (
        <p className="text-[13px] text-[var(--color-success)]">
          Bound and verified: <span className="tabular">{bound}</span>
        </p>
      ) : null}
      {error ? (
        <p className="text-[13px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
