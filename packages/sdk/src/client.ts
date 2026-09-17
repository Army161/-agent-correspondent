/**
 * A thin, typed client over the Agent Correspondent v1 HTTP API.
 *
 * This wraps the exact endpoints documented in the repository's docs/ — it
 * has no logic of its own about mandates, netting, or settlement; every
 * decision still happens server-side. It exists so an integrator does not
 * have to hand-roll fetch calls and re-derive the request shapes from the
 * docs.
 */

import { AgentCorrespondentApiError } from "./errors";

export interface ClientOptions {
  /** e.g. "https://agentcorrespondent.com" or "http://127.0.0.1:3111" for local development. */
  readonly baseUrl: string;
  /** An organization API key, as created in Settings. Omit only for the handful of public endpoints. */
  readonly apiKey?: string;
  /** Override for testing; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export type Mandate = Record<string, unknown>;

export interface CreateAgentInput {
  readonly name: string;
  readonly description?: string;
  readonly provider?: "anthropic" | "openai" | "local";
  readonly model: string;
  readonly systemPrompt?: string;
  readonly mandate?: Mandate;
  readonly capabilities?: readonly {
    capabilityId: string;
    category: string;
    priceUsd: string;
    unit?: string;
    latencyMs?: number;
    validationSupported?: boolean;
  }[];
}

export interface WalletChallenge {
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface BindWalletInput {
  readonly network: "ARC" | "ARC_TESTNET" | "XRPL" | "XRPL_TESTNET";
  readonly address: string;
  readonly custody?: "external" | "circle" | "readonly";
  readonly externalRef?: string;
  readonly isPrimary?: boolean;
  /** Required for `custody: "external"`: the challenge's nonce and the signature answering it. */
  readonly nonce?: string;
  readonly signature?: string;
  readonly publicKey?: string;
}

export interface CompileIntentInput {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly service: string;
  readonly servicePayload?: unknown;
  readonly maxSpend: string;
  readonly minReceive?: string;
  readonly settlementAsset?: "USDC" | "RLUSD" | "EURC" | "XRP";
  readonly allowedRails: readonly string[];
  readonly network?: "ARC" | "ARC_TESTNET" | "XRPL" | "XRPL_TESTNET" | "MULEDGER";
  readonly destination: string;
  readonly evaluator?: string;
  readonly ttlSeconds?: number;
}

export interface SubmitIntentInput {
  readonly intent: unknown;
  readonly signature: string;
  readonly signer: string;
}

export interface CreateJobInput {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly title: string;
  readonly service: string;
  readonly priceUsd: string;
  readonly evaluator?: string;
  readonly requestPayload?: unknown;
}

export type JobTransitionName =
  | "QUOTE"
  | "FUND"
  | "START"
  | "SUBMIT"
  | "EVALUATE"
  | "PASS"
  | "REJECT"
  | "DISPUTE"
  | "RESOLVE_FOR_PROVIDER"
  | "RESOLVE_FOR_BUYER"
  | "SETTLE"
  | "CANCEL";

export interface TransitionJobInput {
  readonly transition: JobTransitionName;
  readonly intentId?: string;
  readonly resultHash?: string;
  readonly deliverableUri?: string;
}

export interface CheckMandateInput {
  readonly agentId: string;
  readonly amountUsd: string;
  readonly asset?: string;
  readonly network?: string;
  readonly counterpartyVerified?: boolean;
  readonly incursCredit?: boolean;
  readonly isTokenTrade?: boolean;
  readonly availableBalanceUsd?: string;
}

export type CredentialType =
  | "CONTROLLER_VERIFIED"
  | "MANDATE_BOUND"
  | "WORK_HISTORY"
  | "SETTLEMENT_PERMITTED";

export interface VerifyCredentialInput {
  readonly document: Record<string, unknown>;
  readonly signature: string;
  readonly issuerPublicKey?: string;
  readonly secondaryAttestation?: { algorithm: "ml-dsa-65"; publicKey: string; signature: string };
}

export const KNOWN_WEBHOOK_EVENTS = ["job.funded", "job.settled"] as const;
export type WebhookEventName = (typeof KNOWN_WEBHOOK_EVENTS)[number];

export class AgentCorrespondentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (!response.ok) throw new AgentCorrespondentApiError(response.status, parsed);
    return parsed as T;
  }

  // -- Agents ---------------------------------------------------------------

  createAgent(input: CreateAgentInput): Promise<{ agentId: string }> {
    return this.request("POST", "/api/v1/agents", input);
  }

  listAgents(): Promise<{ agents: unknown[] }> {
    return this.request("GET", "/api/v1/agents");
  }

  // -- Wallets ----------------------------------------------------------------

  requestWalletChallenge(
    agentId: string,
    network: BindWalletInput["network"],
    address: string,
  ): Promise<WalletChallenge> {
    return this.request("POST", `/api/v1/agents/${agentId}/wallets/challenge`, { network, address });
  }

  bindWallet(agentId: string, input: BindWalletInput): Promise<{ walletId: string }> {
    return this.request("POST", `/api/v1/agents/${agentId}/wallets`, input);
  }

  // -- Economic intents -------------------------------------------------------

  compileIntent(input: CompileIntentInput): Promise<{
    intentId: string;
    intent: unknown;
    typedData: { domain: unknown; types: { EconomicIntent: unknown }; primaryType: string; message: unknown };
    display: unknown;
  }> {
    return this.request("POST", "/api/v1/intents", input);
  }

  submitIntent(input: SubmitIntentInput): Promise<{ intentId: string; status: string }> {
    return this.request("POST", "/api/v1/intents/submit", input);
  }

  // -- Jobs ---------------------------------------------------------------

  createJob(input: CreateJobInput): Promise<{ jobId: string; state: string }> {
    return this.request("POST", "/api/v1/jobs", input);
  }

  getJob(jobId: string): Promise<{ job: Record<string, unknown> }> {
    return this.request("GET", `/api/v1/jobs/${jobId}`);
  }

  listJobs(): Promise<{ jobs: unknown[] }> {
    return this.request("GET", "/api/v1/jobs");
  }

  transitionJob(jobId: string, input: TransitionJobInput): Promise<{ jobId: string; state: string }> {
    return this.request("POST", `/api/v1/jobs/${jobId}/transition`, input);
  }

  // -- Clearing ---------------------------------------------------------------

  getClearing(asset = "USDC"): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/v1/clearing?asset=${encodeURIComponent(asset)}`);
  }

  runClearing(asset = "USDC", mode: "BILATERAL" | "MULTILATERAL" = "BILATERAL"): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/clearing", { asset, mode });
  }

  // -- Mandate ------------------------------------------------------------

  checkMandate(input: CheckMandateInput): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/mandate/check", input);
  }

  // -- Credentials --------------------------------------------------------

  issueCredential(agentId: string, type: CredentialType): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/v1/agents/${agentId}/credentials`, { type });
  }

  revokeCredential(agentId: string, credentialId: string, reason: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/v1/agents/${agentId}/credentials`, { credentialId, reason });
  }

  listCredentials(agentId: string): Promise<{ credentials: unknown[] }> {
    return this.request("GET", `/api/v1/agents/${agentId}/credentials`);
  }

  /** Public, unauthenticated: this does not require an API key even when the client has one. */
  verifyCredential(input: VerifyCredentialInput): Promise<{ valid: boolean; reasons: string[] }> {
    return this.request("POST", "/api/v1/credentials/verify", input);
  }

  // -- Webhooks -------------------------------------------------------------

  createWebhook(
    url: string,
    events: readonly WebhookEventName[],
  ): Promise<{ webhookId: string; secret: string }> {
    return this.request("POST", "/api/v1/webhooks", { url, events });
  }

  listWebhooks(): Promise<{ webhooks: unknown[]; knownEvents: readonly string[] }> {
    return this.request("GET", "/api/v1/webhooks");
  }

  revokeWebhook(webhookId: string): Promise<{ webhookId: string; active: boolean }> {
    return this.request("DELETE", `/api/v1/webhooks/${webhookId}`);
  }
}
