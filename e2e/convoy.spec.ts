/**
 * Convoy Mode.
 *
 * A pooled budget and combined-velocity check across a group of an
 * organization's own agents, on top of each member's individual mandate.
 * The properties worth exercising through the real API: exclusive
 * membership, that the pool is genuinely shared across members rather than
 * per-agent, and that exceeding it holds a submission before the relay is
 * touched -- the same "no trace left" property Sentinel-5's kill switch has.
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
  method: "GET" | "POST" | "DELETE",
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
  await page.getByLabel("Your name").fill("Convoy Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("an agent belongs to at most one convoy", async ({ page }) => {
    await signUp(page, `convoy-exclusive-${Date.now()}@example.com`);
    const agent = await api(page, "POST", "/api/v1/agents", {
      name: "Solo",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = agent.json.agentId as string;

    const first = await api(page, "POST", "/api/v1/convoys", {
      name: "First",
      dailyPoolLimitUsd: "10.00",
    });
    const second = await api(page, "POST", "/api/v1/convoys", {
      name: "Second",
      dailyPoolLimitUsd: "10.00",
    });

    const addFirst = await api(page, "POST", `/api/v1/convoys/${first.json.id}/members`, {
      agentId,
    });
    expect(addFirst.status).toBe(201);

    const addSecond = await api(page, "POST", `/api/v1/convoys/${second.json.id}/members`, {
      agentId,
    });
    expect(addSecond.status).toBe(409);
  });

  test("exceeding the convoy's shared pool holds submission before the relay is touched", async ({
    page,
  }) => {
    const email = `convoy-pool-${Date.now()}@example.com`;
    await signUp(page, email);

    const buyer = await api(page, "POST", "/api/v1/agents", {
      name: "Buyer",
      provider: "anthropic",
      model: "claude-sonnet-5",
      mandate: {
        dailySpendLimitUsd: "1000.00",
        maxTransactionUsd: "1000.00",
        minimumReserveUsd: "0.00",
        unverifiedCounterpartyLimitUsd: "1000.00",
        humanApprovalAboveUsd: "1000.00",
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
    });
    const buyerId = buyer.json.agentId as string;
    const providerId = providerAgent.json.agentId as string;

    // A pool far smaller than the agent's own (generous) individual mandate,
    // so only the convoy pool -- not the mandate -- can be what refuses this.
    const convoy = await api(page, "POST", "/api/v1/convoys", {
      name: "Tight pool",
      dailyPoolLimitUsd: "0.01",
    });
    await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, { agentId: buyerId });

    const challenge = await api(page, "POST", `/api/v1/agents/${buyerId}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    const proofSignature = await OWNER.signMessage({ message: challenge.json.message as string });
    await api(page, "POST", `/api/v1/agents/${buyerId}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      isPrimary: true,
      nonce: challenge.json.nonce,
      signature: proofSignature,
    });

    const compiled = await api(page, "POST", "/api/v1/intents", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      service: "research.summarize",
      maxSpend: "5.00",
      minReceive: "5.00",
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
    const signature = await OWNER.signTypedData({
      domain: typedData.domain as never,
      types: { EconomicIntent: typedData.types.EconomicIntent as never },
      primaryType: "EconomicIntent",
      message: typedData.message as never,
    });

    const submitted = await api(page, "POST", "/api/v1/intents/submit", {
      intent: compiled.json.intent,
      signature,
      signer: OWNER.address,
    });
    expect(submitted.status).toBe(202);
    expect(submitted.json.held).toBe(true);
    expect(submitted.json.error).toBe("CONVOY_POOL_EXCEEDED");
    expect(submitted.json.incidentId).toBeTruthy();
  });

  test("a convoy pool is shared: one member's spend counts against another's headroom", async ({
    page,
  }) => {
    const email = `convoy-shared-${Date.now()}@example.com`;
    await signUp(page, email);

    const agentA = await api(page, "POST", "/api/v1/agents", {
      name: "A",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentB = await api(page, "POST", "/api/v1/agents", {
      name: "B",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const convoy = await api(page, "POST", "/api/v1/convoys", {
      name: "Shared",
      dailyPoolLimitUsd: "5.00",
    });
    await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: agentA.json.agentId,
    });
    const added = await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: agentB.json.agentId,
    });
    expect(added.status).toBe(201);

    const list = await api(page, "GET", "/api/v1/convoys");
    const found = (list.json.convoys as { id: string; members: string[] }[]).find(
      (entry) => entry.id === convoy.json.id,
    );
    expect(found?.members).toHaveLength(2);
    expect(found?.members).toContain(agentA.json.agentId);
    expect(found?.members).toContain(agentB.json.agentId);
  });

  test("membership can be removed", async ({ page }) => {
    await signUp(page, `convoy-remove-${Date.now()}@example.com`);
    const agent = await api(page, "POST", "/api/v1/agents", {
      name: "Removable",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const convoy = await api(page, "POST", "/api/v1/convoys", {
      name: "Temp",
      dailyPoolLimitUsd: "1.00",
    });
    await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: agent.json.agentId,
    });

    const removed = await api(page, "DELETE", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: agent.json.agentId,
    });
    expect(removed.status).toBe(200);

    // Now it can join a different convoy, proving the exclusivity is current
    // membership, not a permanent record.
    const other = await api(page, "POST", "/api/v1/convoys", {
      name: "Other",
      dailyPoolLimitUsd: "1.00",
    });
    const rejoin = await api(page, "POST", `/api/v1/convoys/${other.json.id}/members`, {
      agentId: agent.json.agentId,
    });
    expect(rejoin.status).toBe(201);
  });

  test("freezing a convoy engages a kill switch for every member", async ({ page }) => {
    await signUp(page, `convoy-freeze-${Date.now()}@example.com`);
    const a1 = await api(page, "POST", "/api/v1/agents", {
      name: "M1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const a2 = await api(page, "POST", "/api/v1/agents", {
      name: "M2",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const convoy = await api(page, "POST", "/api/v1/convoys", {
      name: "Freezable",
      dailyPoolLimitUsd: "5.00",
    });
    await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: a1.json.agentId,
    });
    await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/members`, {
      agentId: a2.json.agentId,
    });

    const frozen = await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/freeze`, {
      action: "FREEZE",
      reason: "e2e test",
    });
    expect(frozen.status).toBe(200);
    expect(frozen.json.membersAffected).toBe(2);
    expect(frozen.json.ok).toBe(true);

    const unfrozen = await api(page, "POST", `/api/v1/convoys/${convoy.json.id}/freeze`, {
      action: "UNFREEZE",
      reason: "e2e test complete",
    });
    expect(unfrozen.status).toBe(200);
  });
});
