/**
 * Wallet binding.
 *
 * An address typed into a form is a claim. These tests drive the real
 * challenge/proof exchange with real secp256k1 signatures, and check the four
 * ways someone would try to bind an address they do not control.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const STRANGER = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
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

/** Sign out, so a test can hold two unrelated accounts in one browser. */
async function signOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });
}

async function signUp(page: Page): Promise<void> {
  const email = `wallet-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

async function createAgent(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/v1/agents", {
    name,
    provider: "anthropic",
    model: "claude-sonnet-5",
  });
  expect(created.status).toBe(201);
  return created.json.agentId as string;
}

test.describe("wallet ownership", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("an address cannot be bound without proving control of it", async ({ page }) => {
    await signUp(page);
    const agentId = await createAgent(page, "Buyer");

    const bare = await api(page, "POST", `/api/v1/agents/${agentId}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      isPrimary: true,
    });
    expect(bare.status).toBe(400);
    expect(bare.json.error).toBe("PROOF_REQUIRED");

    const wallets = await api(page, "GET", `/api/v1/agents/${agentId}/wallets`);
    expect(wallets.json.wallets).toEqual([]);
  });

  test("a proof from the right key binds the wallet and marks it verified", async ({ page }) => {
    await signUp(page);
    const agentId = await createAgent(page, "Buyer");

    const challenge = await api(page, "POST", `/api/v1/agents/${agentId}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    expect(challenge.status).toBe(201);

    const message = challenge.json.message as string;
    // The wallet shows this text. It must say what it is for, and must not
    // look like a transaction.
    expect(message).toContain("wants you to sign in with your Ethereum account");
    expect(message).toContain("authorizes nothing and moves no funds");
    expect(message).toContain(`- acor:agent:${agentId}`);

    const signature = await OWNER.signMessage({ message });
    const bound = await api(page, "POST", `/api/v1/agents/${agentId}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      isPrimary: true,
      nonce: challenge.json.nonce,
      signature,
    });
    expect(bound.status).toBe(201);
    expect(bound.json.verified).toBe(true);

    const wallets = await api(page, "GET", `/api/v1/agents/${agentId}/wallets`);
    expect(wallets.json.wallets).toMatchObject([
      { address: OWNER.address.toLowerCase(), verified: true },
    ]);
  });

  test("ATTACK: a stranger's signature does not bind the owner's address", async ({ page }) => {
    await signUp(page);
    const agentId = await createAgent(page, "Buyer");

    const challenge = await api(page, "POST", `/api/v1/agents/${agentId}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    const signature = await STRANGER.signMessage({ message: challenge.json.message as string });

    const bound = await api(page, "POST", `/api/v1/agents/${agentId}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      isPrimary: true,
      nonce: challenge.json.nonce,
      signature,
    });
    expect(bound.status).toBe(400);
    expect(bound.json.error).toBe("SIGNER_MISMATCH");
  });

  test("ATTACK: a proof cannot be replayed, or moved to another agent", async ({ page }) => {
    await signUp(page);
    const first = await createAgent(page, "First");
    const second = await createAgent(page, "Second");

    const challenge = await api(page, "POST", `/api/v1/agents/${first}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    const signature = await OWNER.signMessage({ message: challenge.json.message as string });

    // The proof names the agent it was issued for.
    const elsewhere = await api(page, "POST", `/api/v1/agents/${second}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      nonce: challenge.json.nonce,
      signature,
    });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.json.error).toBe("CHALLENGE_UNKNOWN");

    const bound = await api(page, "POST", `/api/v1/agents/${first}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      nonce: challenge.json.nonce,
      signature,
    });
    expect(bound.status).toBe(201);

    // One challenge, one answer.
    const replayed = await api(page, "POST", `/api/v1/agents/${first}/wallets`, {
      network: "ARC",
      address: OWNER.address,
      custody: "external",
      nonce: challenge.json.nonce,
      signature,
    });
    expect(replayed.status).toBe(400);
    expect(replayed.json.error).toBe("CHALLENGE_UNKNOWN");
  });

  test("ATTACK: a challenge cannot be requested for another organization's agent", async ({
    page,
  }) => {
    await signUp(page);
    const mine = await createAgent(page, "Mine");

    // A second, unrelated account in the same browser.
    await signOut(page);
    await signUp(page);
    const theirs = await api(page, "POST", `/api/v1/agents/${mine}/wallets/challenge`, {
      network: "ARC",
      address: OWNER.address,
    });
    expect(theirs.status).toBe(404);
  });

  test("a watch-only address is recorded as unverified rather than refused", async ({ page }) => {
    await signUp(page);
    const agentId = await createAgent(page, "Watcher");

    const bound = await api(page, "POST", `/api/v1/agents/${agentId}/wallets`, {
      network: "ARC",
      address: "0x000000000000000000000000000000000000dead",
      custody: "readonly",
    });
    expect(bound.status).toBe(201);
    expect(bound.json.verified).toBe(false);

    const wallets = await api(page, "GET", `/api/v1/agents/${agentId}/wallets`);
    expect(wallets.json.wallets).toMatchObject([{ verified: false }]);
  });
});
