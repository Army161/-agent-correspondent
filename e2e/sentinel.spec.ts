/**
 * Sentinel-5: the security control plane.
 *
 * Exercises the parts a unit test cannot reach: that engaging a kill switch
 * actually refuses a submission before the relay is ever touched — leaving no
 * intent recorded — that disengaging restores normal (relay-governed) refusal
 * behaviour rather than bypassing it, that self-service containment is scoped
 * to the caller's own resources, and that platform-wide containment requires
 * the operator allowlist.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function api(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(
    async ([method, path, body]) => {
      const response = await fetch(path as string, {
        method: method as string,
        ...(body === null
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, json };
    },
    [method, path, body ?? null] as const,
  );
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Sentinel Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

/**
 * Sign in as the shared operator account, creating it on first use.
 *
 * The operator identity is checked by exact email against
 * PLATFORM_OPERATOR_EMAILS, so unlike every other test here it cannot use a
 * fresh email per test -- the account is shared and must be idempotent.
 */
async function signInAsOperator(page: Page): Promise<void> {
  await page.goto("/login");
  const signedIn = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "operator@example.com", password: "correct-horse-battery-staple" }),
    });
    return response.ok;
  });
  if (signedIn) {
    await page.goto("/chat");
    return;
  }
  await signUp(page, "operator@example.com");
}

async function signOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("an owner can freeze and unfreeze their own agent", async ({ page }) => {
    const email = `sentinel-agent-${Date.now()}@example.com`;
    await signUp(page, email);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Buyer",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    const engaged = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "AGENT",
      target: agentId,
      action: "ENGAGE",
      reason: "suspected compromise",
    });
    expect(engaged.status).toBe(200);

    const disengaged = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "AGENT",
      target: agentId,
      action: "DISENGAGE",
      reason: "false alarm",
    });
    expect(disengaged.status).toBe(200);
  });

  test("a frozen agent's submission is refused before the relay is touched", async ({ page }) => {
    const email = `sentinel-submit-${Date.now()}@example.com`;
    await signUp(page, email);

    const buyer = await api(page, "POST", "/api/v1/agents", {
      name: "Buyer",
      provider: "anthropic",
      model: "claude-sonnet-5",
      mandate: {
        dailySpendLimitUsd: "10.00",
        maxTransactionUsd: "5.00",
        minimumReserveUsd: "-0.00",
        unverifiedCounterpartyLimitUsd: "5.00",
        humanApprovalAboveUsd: "10.00",
        creditAllowed: false,
        tokenTradingAllowed: false,
        allowedAssets: ["USDC"],
        allowedNetworks: ["MULEDGER"],
      },
    });
    const providerAgent = await api(page, "POST", "/api/v1/agents", {
      name: "Provider",
      provider: "anthropic",
      model: "claude-sonnet-5",
      capabilities: [
        { capabilityId: "summarize", category: "summarization", priceUsd: "0.02", latencyMs: 100 },
      ],
    });
    const buyerId = buyer.json.agentId as string;
    const providerId = providerAgent.json.agentId as string;

    const challenge = await api(page, "POST", `/api/v1/agents/${buyerId}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    const signature = await OWNER.signMessage({ message: challenge.json.message as string });
    await api(page, "POST", `/api/v1/agents/${buyerId}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      isPrimary: true,
      nonce: challenge.json.nonce,
      signature,
    });

    // Engage containment before the intent ever exists.
    await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "AGENT",
      target: buyerId,
      action: "ENGAGE",
      reason: "e2e test",
    });

    const compiled = await api(page, "POST", "/api/v1/intents", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      service: "research.summarize",
      maxSpend: "0.02",
      minReceive: "0.02",
      settlementAsset: "USDC",
      network: "MULEDGER",
      allowedRails: ["MULEDGER"],
      destination: providerId,
      ttlSeconds: 300,
    });
    expect(compiled.status).toBe(200);

    const typedData = compiled.json.typedData as {
      domain: unknown;
      types: { EconomicIntent: unknown };
      message: unknown;
    };
    const sig = await OWNER.signTypedData({
      domain: typedData.domain as never,
      types: { EconomicIntent: typedData.types.EconomicIntent as never },
      primaryType: "EconomicIntent",
      message: typedData.message as never,
    });

    const submitted = await api(page, "POST", "/api/v1/intents/submit", {
      intent: compiled.json.intent,
      signature: sig,
      signer: OWNER.address,
    });
    expect(submitted.status).toBe(503);
    expect(submitted.json.error).toBe("KILL_SWITCH_ENGAGED");
    expect(submitted.json.incidentId).toBeTruthy();

    // Disengaging restores relay-governed behaviour -- not blanket approval.
    // The buyer has no funded μLedger position, so the relay itself now
    // refuses on economic grounds, proving the kill switch was the only
    // thing standing in the way before, and nothing was silently bypassed.
    await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "AGENT",
      target: buyerId,
      action: "DISENGAGE",
      reason: "e2e test complete",
    });
    const compiled2 = await api(page, "POST", "/api/v1/intents", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      service: "research.summarize",
      maxSpend: "0.02",
      minReceive: "0.02",
      settlementAsset: "USDC",
      network: "MULEDGER",
      allowedRails: ["MULEDGER"],
      destination: providerId,
      ttlSeconds: 300,
    });
    const typedData2 = compiled2.json.typedData as {
      domain: unknown;
      types: { EconomicIntent: unknown };
      message: unknown;
    };
    const sig2 = await OWNER.signTypedData({
      domain: typedData2.domain as never,
      types: { EconomicIntent: typedData2.types.EconomicIntent as never },
      primaryType: "EconomicIntent",
      message: typedData2.message as never,
    });
    const resubmitted = await api(page, "POST", "/api/v1/intents/submit", {
      intent: compiled2.json.intent,
      signature: sig2,
      signer: OWNER.address,
    });
    expect(resubmitted.status).toBe(422);
    expect(resubmitted.json.error).not.toBe("KILL_SWITCH_ENGAGED");

    const incidents = await api(page, "GET", "/api/v1/security/incidents");
    const found = (incidents.json.incidents as { code: string }[]).some(
      (incident) => incident.code === "KILL_SWITCH_ENGAGED",
    );
    expect(found).toBe(true);
  });

  test("only an owner's own agent can be frozen, never another organization's", async ({ page }) => {
    await signUp(page, `sentinel-owner-${Date.now()}@example.com`);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Not yours",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    await signOut(page);
    await signUp(page, `sentinel-attacker-${Date.now()}@example.com`);
    const attempt = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "AGENT",
      target: agentId,
      action: "ENGAGE",
      reason: "trying to freeze someone else's agent",
    });
    expect(attempt.status).toBe(404);
  });

  test("a platform-wide switch requires the operator allowlist", async ({ page }) => {
    await signUp(page, `sentinel-nonop-${Date.now()}@example.com`);
    const attempt = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "RAIL",
      target: "ARC",
      action: "ENGAGE",
      reason: "not an operator",
    });
    expect(attempt.status).toBe(403);
    expect(attempt.json.error).toBe("NOT_A_PLATFORM_OPERATOR");
  });

  test("an operator can engage and disengage a platform-wide rail switch", async ({ page }) => {
    await signInAsOperator(page);
    const engaged = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "RAIL",
      target: "ARC",
      action: "ENGAGE",
      reason: "operator e2e test",
    });
    expect(engaged.status).toBe(200);

    const listed = await api(page, "GET", "/api/v1/security/kill-switch");
    expect(listed.json.isOperator).toBe(true);
    const engagedRails = (listed.json.engaged as { scope: string; target: string }[]).filter(
      (entry) => entry.scope === "RAIL" && entry.target === "ARC",
    );
    expect(engagedRails.length).toBeGreaterThan(0);

    const disengaged = await api(page, "POST", "/api/v1/security/kill-switch", {
      scope: "RAIL",
      target: "ARC",
      action: "DISENGAGE",
      reason: "operator e2e test complete",
    });
    expect(disengaged.status).toBe(200);
  });

  test("provider quarantine also requires the operator allowlist", async ({ page }) => {
    await signUp(page, `sentinel-quar-nonop-${Date.now()}@example.com`);
    const attempt = await api(page, "POST", "/api/v1/security/quarantine", {
      providerId: "arc",
      action: "QUARANTINE",
      reason: "not an operator",
    });
    expect(attempt.status).toBe(403);
  });

  test("an operator can quarantine and lift a provider", async ({ page }) => {
    await signInAsOperator(page);
    const quarantined = await api(page, "POST", "/api/v1/security/quarantine", {
      providerId: "circle",
      action: "QUARANTINE",
      reason: "operator e2e test",
    });
    expect(quarantined.status).toBe(200);

    const listed = await api(page, "GET", "/api/v1/security/quarantine");
    const found = (listed.json.quarantined as { providerId: string }[]).some(
      (entry) => entry.providerId === "circle",
    );
    expect(found).toBe(true);

    const lifted = await api(page, "POST", "/api/v1/security/quarantine", {
      providerId: "circle",
      action: "LIFT",
    });
    expect(lifted.status).toBe(200);
  });
});
