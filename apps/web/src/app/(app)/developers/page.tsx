import type { Metadata } from "next";

import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  Code,
  EmptyState,
  Panel,
  PanelHeader,
  stateTone,
} from "@/components/ui/primitives";
import { probeAll, getSettlementPlane } from "@acor/adapters";
import { currentUser } from "@/lib/auth";
import { serviceStates } from "@/lib/env";

export const metadata: Metadata = {
  title: "Developers",
  description: "REST API, MCP integration, webhooks and live network capabilities.",
};

export const dynamic = "force-dynamic";

const ENDPOINTS = [
  ["GET", "/api/health", "Platform and adapter health"],
  ["GET", "/api/v1/network/capabilities", "Live state of every network primitive"],
  ["GET", "/api/v1/agents", "Agents in your organization"],
  ["POST", "/api/v1/agents", "Create an agent with a mandate"],
  ["GET", "/api/v1/quotes", "Rank providers on effective cost"],
  ["POST", "/api/v1/intents", "Compile a signable EconomicIntent"],
  ["POST", "/api/v1/intents/relay", "Submit a signed intent to the relay"],
  ["POST", "/api/v1/mandate/check", "Test a spend against a mandate"],
  ["GET", "/api/v1/clearing", "Gross, net and projected clearing"],
  ["GET", "/api/v1/receipts", "Immutable economic receipts"],
  ["GET", "/api/v1/reputation/:agentId", "Derived reputation and its evidence"],
] as const;

export default async function DevelopersPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const [adapters] = await Promise.all([probeAll()]);
  const { capabilities, configurationErrors } = getSettlementPlane();
  const services = serviceStates();

  return (
    <>
      <PageHeader
        eyebrow="Developer platform"
        title="Developers"
        description="The same economic kernel the product runs on, over HTTP. Authenticate with an API key; every economic call passes through the mandate engine exactly as the UI does."
      />

      {configurationErrors.length > 0 ? (
        <Panel className="mb-4 border-[rgba(255,92,112,0.4)]">
          <PanelHeader
            title="Configuration errors"
            description="These must be resolved before this deployment can settle anything."
          />
          <ul className="space-y-2 px-5 pb-4">
            {configurationErrors.map((error) => (
              <li key={error} className="text-[13px] text-[var(--color-danger)]">
                {error}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="REST API" description="Versioned under /api/v1." />
          <ul className="divide-y divide-[var(--color-border)]">
            {ENDPOINTS.map(([method, path, description]) => (
              <li key={`${method} ${path}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Badge tone={method === "GET" ? "neutral" : "cyan"}>{method}</Badge>
                <code className="tabular text-[13px] text-[var(--color-bright)]">{path}</code>
                <span className="text-[12px] text-[var(--color-muted)]">{description}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="API keys" description="Shown once at creation, stored only as a hash." />
          <EmptyState
            title={user ? "NO KEYS ISSUED" : "NOT SIGNED IN"}
            description={
              user
                ? "Issuing API keys requires a configured database. Keys are displayed once and stored only as a SHA-256 hash."
                : "Sign in to manage API keys for your organization."
            }
          />
        </Panel>

        <Panel className="lg:col-span-3">
          <PanelHeader
            title="Network capabilities"
            description="Live state of every network primitive. Nothing executes against a primitive that is not verified live — UNKNOWN is treated exactly like DISABLED."
          />
          <div className="grid gap-px bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.list().map((capability) => (
              <div
                key={capability.id}
                className="flex items-center justify-between gap-3 bg-[var(--color-panel)] px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="tabular truncate text-[13px]">{capability.id}</div>
                  {capability.note ? (
                    <div className="mt-0.5 truncate text-[11px] text-[var(--color-subtle)]">
                      {capability.note}
                    </div>
                  ) : null}
                </div>
                <Badge tone={stateTone(capability.state)}>{capability.state}</Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="MCP integration" description="Expose your agents to MCP-aware clients." />
          <div className="px-5 pb-5">
            <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
              Agent Correspondent discovers providers from internal agents, ERC-8004 identities, MCP
              servers, A2A endpoints and x402-priced services, and normalizes them all into one
              shape before procurement ranks them. A provider with no payout destination or no
              priced capability is dropped rather than shown.
            </p>
            <div className="mt-4 overflow-x-auto">
              <pre className="tabular text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                <code>{`curl -X POST https://agentcorrespondent.com/api/v1/mandate/check \\
  -H "authorization: Bearer $ACOR_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"agentId":"agent_...","amountUsd":"0.05","asset":"USDC","network":"ARC"}'

# 200 { "decision": "ALLOW", ... }
# 200 { "decision": "DENY", "violations": [{"code":"DAILY_LIMIT_EXCEEDED", ...}] }`}</code>
              </pre>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Service configuration" description="What this deployment has." />
          <ul className="divide-y divide-[var(--color-border)]">
            {services.map((service) => (
              <li key={service.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px]">{service.label}</div>
                  {!service.configured ? (
                    <div className="mt-0.5 truncate text-[11px] text-[var(--color-subtle)]">
                      <Code>{service.requires.join(", ")}</Code>
                    </div>
                  ) : null}
                </div>
                <Badge tone={service.configured ? "success" : "neutral"}>
                  {service.configured ? "CONFIGURED" : "MISSING"}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="lg:col-span-3">
          <PanelHeader title="Adapters" description="Settlement plane health." />
          <ul className="divide-y divide-[var(--color-border)]">
            {adapters.map((adapter) => (
              <li
                key={adapter.adapter}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-medium capitalize">{adapter.adapter}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--color-muted)]">{adapter.detail}</div>
                </div>
                <Badge tone={stateTone(adapter.status)}>{adapter.status}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
