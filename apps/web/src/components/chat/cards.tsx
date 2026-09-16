/**
 * Action cards.
 *
 * When the kernel makes an economic decision, the chat shows the decision
 * itself — the rule that fired, the price that was quoted, the rail that was
 * chosen — rather than the model's prose summary of it. If the two ever
 * disagree, the card is the truth.
 */

import { Badge, Panel, stateTone } from "@/components/ui/primitives";

export interface ActionCard {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

type Json = Record<string, unknown>;

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function CardShell({
  title,
  tone = "neutral",
  status,
  children,
}: {
  title: string;
  tone?: Parameters<typeof Badge>[0]["tone"];
  status?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel className="bg-[var(--color-elevated)] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
          {title}
        </span>
        {status ? <Badge tone={tone}>{status}</Badge> : null}
      </div>
      <div className="mt-3">{children}</div>
    </Panel>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <dl className="space-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 text-[13px]">
          <dt className="shrink-0 text-[var(--color-subtle)]">{label}</dt>
          <dd className="tabular min-w-0 truncate text-right text-[var(--color-bright)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ErrorCard({ output }: { output: Json }): React.JSX.Element {
  const violations = Array.isArray(output.violations)
    ? (output.violations as { code?: string; message?: string }[])
    : [];
  return (
    <CardShell title="Blocked" tone="danger" status={str(output.error, "ERROR")}>
      {output.message ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">{str(output.message)}</p>
      ) : null}
      {violations.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {violations.map((violation, index) => (
            <li key={`${violation.code}-${index}`} className="text-[13px]">
              <span className="tabular text-[var(--color-danger)]">{violation.code}</span>
              <span className="text-[var(--color-muted)]"> — {violation.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </CardShell>
  );
}

export function ActionCardView({ card }: { card: ActionCard }): React.JSX.Element {
  const output = asJson(card.output);

  if (!output) {
    return (
      <CardShell title={card.tool.replaceAll("_", " ")}>
        <p className="text-[13px] text-[var(--color-muted)]">The tool returned no result.</p>
      </CardShell>
    );
  }

  if (typeof output.error === "string") return <ErrorCard output={output} />;

  switch (card.tool) {
    case "discover_providers": {
      const providers = Array.isArray(output.providers)
        ? (output.providers as Json[])
        : [];
      if (providers.length === 0) {
        return (
          <CardShell title="Agent discovery" status="NONE FOUND" tone="warning">
            <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
              {str(output.message, "No providers matched.")}
            </p>
          </CardShell>
        );
      }
      return (
        <CardShell
          title="Agents found"
          status={`${providers.length} provider${providers.length === 1 ? "" : "s"}`}
          tone="cyan"
        >
          <div className="space-y-3">
            {providers.slice(0, 5).map((provider, index) => (
              <div
                key={str(provider.agentId, String(index))}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-[13px] font-medium">
                    {str(provider.displayName)}
                  </span>
                  {index === 0 ? <Badge tone="success">Best value</Badge> : null}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  {[
                    ["Price", str(provider.price)],
                    ["Effective", str(provider.effectiveCost)],
                    ["Reputation", provider.reputation === null ? "—" : str(provider.reputation)],
                    ["Latency", `${str(provider.latencyMs, "0")}ms`],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-subtle)]">
                        {label}
                      </div>
                      <div className="tabular mt-0.5 text-[13px]">{value}</div>
                    </div>
                  ))}
                </div>
                {provider.verified === false ? (
                  <div className="mt-2 text-[11px] text-[var(--color-warning)]">
                    Unverified counterparty — priced with a risk premium.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {output.note ? (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-subtle)]">
              {str(output.note)}
            </p>
          ) : null}
        </CardShell>
      );
    }

    case "check_mandate": {
      const decision = str(output.decision, "DENY");
      const violations = Array.isArray(output.violations)
        ? (output.violations as { code?: string; message?: string }[])
        : [];
      return (
        <CardShell title="Economic mandate" status={str(output.summary, decision)} tone={stateTone(decision)}>
          {violations.length > 0 ? (
            <ul className="space-y-1.5">
              {violations.map((violation, index) => (
                <li key={`${violation.code}-${index}`} className="text-[13px]">
                  <span className="tabular text-[var(--color-danger)]">{violation.code}</span>
                  <span className="text-[var(--color-muted)]"> — {violation.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-[var(--color-muted)]">
              Every rule in the mandate passed for this spend.
            </p>
          )}
        </CardShell>
      );
    }

    case "compile_intent": {
      const intent = asJson(output.intent);
      if (!intent) return <ErrorCard output={output} />;
      return (
        <CardShell title="Economic intent" status="AWAITING SIGNATURE" tone="warning">
          <Rows
            rows={[
              ["Maximum", str(intent.maxSpend)],
              ["Minimum received", str(intent.minReceive)],
              ["Provider", str(intent.provider)],
              ["Settlement", `${str(intent.settlementAsset)} on ${str(intent.network)}`],
              ["Rails", str(intent.rails)],
              ["Expires", str(intent.expiresAt)],
            ]}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-subtle)]">
            Nothing has been spent. This authorization takes effect only when you sign it, and the
            mandate engine re-checks it at execution.
          </p>
        </CardShell>
      );
    }

    case "route_payment": {
      return (
        <CardShell title="Economic route" status={str(output.rail)} tone="cyan">
          <Rows
            rows={[
              ["Rail", str(output.rail)],
              ["Mechanism", str(output.mechanism)],
              ["Network", str(output.network)],
              ["Settlement timing", str(output.timing)],
              ["Validation", str(output.validation)],
            ]}
          />
          {output.rationale ? (
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
              {str(output.rationale)}
            </p>
          ) : null}
        </CardShell>
      );
    }

    case "ledger_summary": {
      return (
        <CardShell title="μLedger" status={`${str(output.openObligations, "0")} open`} tone="cyan">
          <Rows
            rows={[
              ["Gross outstanding", str(output.gross, "—")],
              ["Asset", str(output.asset, "USDC")],
            ]}
          />
          {output.message ? (
            <p className="mt-3 text-[12px] text-[var(--color-muted)]">{str(output.message)}</p>
          ) : null}
        </CardShell>
      );
    }

    case "spend_report": {
      return (
        <CardShell title="Spend today" tone="neutral" status={str(output.spentTodayUsd, "—")}>
          <Rows
            rows={[
              ["Agent", str(output.agentId)],
              ["Since", str(output.since)],
            ]}
          />
        </CardShell>
      );
    }

    default:
      return (
        <CardShell title={card.tool.replaceAll("_", " ")}>
          <pre className="tabular overflow-x-auto text-[12px] text-[var(--color-muted)]">
            {JSON.stringify(output, null, 2)}
          </pre>
        </CardShell>
      );
  }
}
