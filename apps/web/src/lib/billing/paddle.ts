/**
 * The Paddle API, server side only.
 *
 * Two operations are needed: create a transaction so a checkout can be opened
 * for it, and read a subscription back so the local state can be reconciled
 * against the provider's.
 *
 * The transaction is created *here*, not in the browser, because it carries
 * `custom_data.organizationId`. If the browser supplied that, anyone could buy
 * a subscription for someone else's organization — or, more usefully to an
 * attacker, have their own payment credit an organization they do not own.
 */

import "server-only";

import { paddleEnvironment } from "../plans";

const ENDPOINTS = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
} as const;

function apiKey(): string | null {
  const value = process.env.PADDLE_API_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

export function paddleApiBase(): string {
  const override = process.env.PADDLE_API_BASE?.trim();
  if (override && override.length > 0) return override.replace(/\/$/, "");
  return ENDPOINTS[paddleEnvironment()];
}

/** The public client token Paddle.js needs. Not a secret, but still configuration. */
export function paddleClientToken(): string | null {
  const value = process.env.PADDLE_CLIENT_TOKEN?.trim();
  return value && value.length > 0 ? value : null;
}

export type PaddleOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<PaddleOutcome<T>> {
  const key = apiKey();
  if (!key) return { ok: false, error: "PADDLE_API_KEY is not configured" };

  try {
    const response = await fetch(`${paddleApiBase()}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "paddle-version": "1",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      // The provider's error body can quote the request. Truncate it rather
      // than letting an arbitrary string reach a log or a page.
      return { ok: false, error: `Paddle returned ${response.status}: ${text.slice(0, 300)}` };
    }
    const parsed = JSON.parse(text) as { data?: unknown };
    return { ok: true, value: parsed.data as T };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Paddle request failed" };
  }
}

export interface CreatedTransaction {
  readonly id: string;
}

/**
 * Create a transaction for one price, bound to one organization.
 *
 * The returned id is what the browser opens a checkout for. It is not a
 * capability to change anything: the organization is already fixed in the
 * transaction's custom data, server-side.
 */
export async function createTransaction(input: {
  priceId: string;
  organizationId: string;
  customerEmail: string;
  quantity?: number;
}): Promise<PaddleOutcome<CreatedTransaction>> {
  return request<CreatedTransaction>("/transactions", {
    method: "POST",
    body: {
      items: [{ price_id: input.priceId, quantity: input.quantity ?? 1 }],
      custom_data: { organizationId: input.organizationId },
      customer: { email: input.customerEmail },
      collection_mode: "automatic",
    },
  });
}

export interface PaddleSubscription {
  readonly id: string;
  readonly status: string;
  readonly custom_data?: Record<string, unknown> | null;
  readonly items?: unknown;
  readonly current_billing_period?: { ends_at?: string } | null;
  readonly customer_id?: string;
  readonly scheduled_change?: { effective_at?: string } | null;
}

export async function getSubscription(id: string): Promise<PaddleOutcome<PaddleSubscription>> {
  return request<PaddleSubscription>(`/subscriptions/${encodeURIComponent(id)}`, { method: "GET" });
}

/**
 * A short-lived URL for the customer to manage or cancel their subscription.
 *
 * Cancellation is deliberately the provider's page rather than a button here:
 * a customer must be able to stop paying without our code being involved.
 */
export async function customerPortalUrl(
  customerId: string,
): Promise<PaddleOutcome<string | null>> {
  const result = await request<{ urls?: { general?: { overview?: string } } }>(
    `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    { method: "POST", body: {} },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.urls?.general?.overview ?? null };
}
