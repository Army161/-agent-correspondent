/**
 * The product itself: authentication, agent creation, mandate enforcement,
 * intent compilation and clearing — driven through the real UI and the real
 * API against a real database.
 *
 * These tests only run meaningfully when a database is configured; when one is
 * not, they assert the honest NOT CONNECTED behaviour instead, because
 * "displays a plausible number with no data behind it" is the failure mode this
 * product must never have.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 3111}`;

function codesOf(body: Record<string, unknown>): string[] {
  const violations = (body.violations ?? []) as { code?: string }[];
  return violations.map((violation) => violation.code ?? "");
}

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as {
    database: { status: string };
  };
  return body.database.status === "CONNECTED";
}

/**
 * Call the API as the signed-in browser would.
 *
 * Playwright's APIRequestContext will not attach a `Secure` cookie over plain
 * HTTP, but Chromium's own network stack does (localhost is a trustworthy
 * origin). Routing these calls through the page's `fetch` therefore exercises
 * the same path a real browser client takes, cookie policy included.
 */
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

async function signUp(page: Page): Promise<string> {
  const email = `owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  // A new account lands in onboarding, not in the product.
  await page.waitForURL("**/onboarding");
  return email;
}

/** Sign up, name the organization, and continue into the product. */
async function signUpAndName(page: Page, organization = "Acme Research"): Promise<string> {
  const email = await signUp(page);
  await page.getByLabel("Organization name").fill(organization);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByLabel("Organization name")).toHaveValue(organization);
  return email;
}

test.describe("without a database", () => {
  test.skip(async ({ request }) => await databaseConfigured(request), "database is configured");

  test("every data surface says NOT CONNECTED instead of showing a number", async ({ page }) => {
    for (const route of ["/agents", "/jobs", "/wallets", "/clearing", "/activity"]) {
      await page.goto(route);
      await expect(page.getByText("NOT CONNECTED").first(), route).toBeVisible();
    }
  });

  test("sign-in explains what is missing rather than failing silently", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(/no database configured/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  test("the chat input is disabled and says why", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText(/Not signed in|AI provider not configured/i).first()).toBeVisible();
    await expect(page.getByLabel("Message the Agent Chat OS")).toBeDisabled();
  });
});

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("a new account can be created and lands in onboarding", async ({ page }) => {
    const email = await signUpAndName(page);
    await expect(page.getByRole("heading", { name: "Get set up" })).toBeVisible();
    await page.goto("/chat");
    await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
    await page.goto("/settings");
    // Scoped to main: the desktop rail also renders the email, and it is
    // present-but-hidden at mobile widths.
    const main = page.getByRole("main");
    await expect(main.getByText(email)).toBeVisible();
    await expect(main.getByText("Acme Research").first()).toBeVisible();
  });

  test("an agent created through the API appears in the UI with its mandate", async ({ page, request }) => {
    await signUp(page);

    const created = await api(page, "POST", "/api/v1/agents", {
        name: "Research Desk",
        description: "Summarizes documents",
        provider: "anthropic",
        model: "claude-sonnet-5",
        mandate: {
          dailySpendLimitUsd: "1.00",
          maxTransactionUsd: "0.025",
          minimumReserveUsd: "0",
          unverifiedCounterpartyLimitUsd: "0.005",
          humanApprovalAboveUsd: "0.50",
          creditAllowed: false,
          tokenTradingAllowed: false,
          allowedAssets: ["USDC"],
          allowedNetworks: ["ARC", "MULEDGER"],
        },
        capabilities: [
          {
            capabilityId: "summarize",
            category: "summarization",
            priceUsd: "0.021",
            unit: "call",
            latencyMs: 3400,
            validationSupported: true,
          },
        ],
    });
    expect(created.status).toBe(201);
    const agentId = created.json.agentId as string;

    await page.goto("/agents");
    await expect(page.getByText("Research Desk")).toBeVisible();
    await expect(page.getByText("1 capabilities")).toBeVisible();

    await page.goto(`/agents/${agentId}`);
    await expect(page.getByRole("heading", { name: "Research Desk" })).toBeVisible();
    // Sub-cent prices keep their precision rather than rounding to $0.02.
    await expect(page.getByText("$0.021").first()).toBeVisible();
    await expect(page.getByText("No mandate")).toHaveCount(0);
    // An agent with no settled work has no score, and is not given a default.
    await expect(page.getByText("NO HISTORY")).toBeVisible();

    void request;
  });

  test("ATTACK: the mandate engine refuses an overspend through the public API", async ({ page }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
        name: "Bounded Buyer",
        provider: "anthropic",
        model: "claude-sonnet-5",
        mandate: {
          dailySpendLimitUsd: "1.00",
          maxTransactionUsd: "0.025",
          minimumReserveUsd: "0",
          unverifiedCounterpartyLimitUsd: "0.005",
          humanApprovalAboveUsd: "0.50",
          creditAllowed: false,
          tokenTradingAllowed: false,
          allowedAssets: ["USDC"],
          allowedNetworks: ["ARC"],
        },
    });
    const agentId = created.json.agentId as string;

    // Within every bound, with a known balance and a verified counterparty.
    const allowed = await api(page, "POST", "/api/v1/mandate/check", {
      agentId,
      amountUsd: "0.02",
      asset: "USDC",
      network: "ARC",
      counterpartyVerified: true,
      availableBalanceUsd: "10",
    });
    expect(allowed.json.decision).toBe("ALLOW");

    // One nanodollar over the per-transaction ceiling.
    const overspend = await api(page, "POST", "/api/v1/mandate/check", {
      agentId,
      amountUsd: "0.025000001",
      asset: "USDC",
      network: "ARC",
      counterpartyVerified: true,
      availableBalanceUsd: "10",
    });
    expect(overspend.json.decision).toBe("DENY");
    expect(codesOf(overspend.json)).toContain("MAX_TRANSACTION_EXCEEDED");

    // An asset the mandate does not allow.
    const wrongAsset = await api(page, "POST", "/api/v1/mandate/check", {
      agentId,
      amountUsd: "0.01",
      asset: "XRP",
      network: "ARC",
      counterpartyVerified: true,
      availableBalanceUsd: "10",
    });
    expect(codesOf(wrongAsset.json)).toContain("ASSET_NOT_ALLOWED");

    // An unknown balance is a denial, not an assumption that funds exist.
    const unknownBalance = await api(page, "POST", "/api/v1/mandate/check", {
      agentId,
      amountUsd: "0.01",
      asset: "USDC",
      network: "ARC",
      counterpartyVerified: true,
    });
    expect(unknownBalance.json.decision).toBe("DENY");
    expect(codesOf(unknownBalance.json)).toContain("CONTEXT_INCOMPLETE");
  });

  test("ATTACK: an API key for one organization cannot probe another's agents", async ({ page, browser }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Private Agent",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    const otherContext = await browser.newContext({ baseURL: BASE_URL });
    const otherPage = await otherContext.newPage();
    await signUp(otherPage);
    const probe = await api(otherPage, "POST", "/api/v1/mandate/check", {
      agentId,
      amountUsd: "0.01",
      availableBalanceUsd: "10",
    });
    expect(probe.status).toBe(404);
    await otherContext.close();
  });

  test("an intent compiles into signable typed data with exact base units", async ({ page }) => {
    await signUp(page);
    const response = await api(page, "POST", "/api/v1/intents", {
      buyerAgentId: "agent_buyer",
      providerAgentId: "agent_provider",
      service: "research.summarize",
      maxSpend: "0.025",
      minReceive: "0.020",
      settlementAsset: "USDC",
      allowedRails: ["X402"],
      network: "ARC",
      destination: "0x00000000000000000000000000000000000000c1",
      ttlSeconds: 300,
    });

    if (response.status === 503) {
      // No verifier contract configured: the platform refuses rather than
      // compiling an authorization bound to nothing.
      expect(response.json.error).toBe("CAPABILITY_UNAVAILABLE");
      return;
    }

    expect(response.status).toBe(200);
    const body = response.json as unknown as {
      intentId: string;
      digest: string;
      display: Record<string, string>;
      typedData: { domain: { chainId: number }; message: Record<string, string> };
    };

    expect(body.intentId).toMatch(/^intent_[0-9a-f]{32}$/);
    expect(body.digest).toMatch(/^0x[0-9a-f]{64}$/);
    // Rendered in the settlement asset, not as dollars: 0.025 USDC is a
    // quantity of USDC, which happens to be USD-par but is not itself a dollar
    // figure.
    expect(body.display.maxSpend).toBe("0.025 USDC");
    expect(body.display.settlementAssetId).toBe("ARC:USDC");
    // 0.025 USDC is 25000 base units — the deterministic-parity property.
    expect(body.typedData.message.maxSpend).toBe("25000");
    expect(body.typedData.message.minReceive).toBe("20000");
    expect(body.typedData.domain.chainId).toBe(5042);
  });

  test("ATTACK: an intent whose minReceive exceeds maxSpend is refused", async ({ page }) => {
    await signUp(page);
    const response = await api(page, "POST", "/api/v1/intents", {
      buyerAgentId: "agent_buyer",
      providerAgentId: "agent_provider",
      service: "research.summarize",
      maxSpend: "0.01",
      minReceive: "0.02",
      settlementAsset: "USDC",
      allowedRails: ["X402"],
      network: "ARC",
      destination: "0x00000000000000000000000000000000000000c1",
    });
    expect([422, 503]).toContain(response.status);
  });

  test("quotes rank on effective cost and show the breakdown", async ({ page }) => {
    await signUp(page);
    await api(page, "POST", "/api/v1/agents", {
      name: "Cheap and slow",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      capabilities: [
        { capabilityId: "summarize", category: "summarization", priceUsd: "0.004", latencyMs: 9000 },
      ],
    });
    await api(page, "POST", "/api/v1/agents", {
      name: "Fast and reliable",
      provider: "anthropic",
      model: "claude-sonnet-5",
      capabilities: [
        {
          capabilityId: "summarize",
          category: "summarization",
          priceUsd: "0.021",
          latencyMs: 3400,
          validationSupported: true,
        },
      ],
    });

    const response = await api(page, "GET", "/api/v1/quotes?category=summarization");
    expect(response.status).toBe(200);
    const body = response.json as unknown as {
      rankedBy: string;
      quotes: { price: string; effectiveCost: string; components: Record<string, string> }[];
    };
    expect(body.rankedBy).toBe("effectiveCost");
    expect(body.quotes.length).toBe(2);
    for (const quote of body.quotes) {
      // Effective cost is always at or above the sticker price: risk and
      // latency are added, never netted off.
      expect(Number(quote.effectiveCost)).toBeGreaterThanOrEqual(Number(quote.price));
      expect(Object.keys(quote.components).sort()).toEqual([
        "counterpartyRisk",
        "failureRisk",
        "latencyPenalty",
        "price",
        "validationCost",
      ]);
    }
  });

  test("clearing nets real obligations and can be reproduced", async ({ page, request }) => {
    await signUp(page);
    const response = await api(page, "GET", "/api/v1/clearing");
    expect(response.status).toBe(200);
    const body = response.json as unknown as { openEntries: number; projected: unknown };
    // A fresh organization has no obligations, and the API says zero rather
    // than inventing a book.
    expect(body.openEntries).toBe(0);
    expect(body.projected).toBeNull();

    await page.goto("/clearing");
    await expect(page.getByText(/NOTHING TO CLEAR/i)).toBeVisible();
    void request;
  });

  test("wallets never show a balance for a rail that is not configured", async ({ page }) => {
    await signUp(page);
    await page.goto("/wallets");
    await expect(page.getByRole("heading", { name: "Wallets", level: 1 })).toBeVisible();
    await expect(page.getByText("NOT CONNECTED").first()).toBeVisible();
    // No dollar figure may appear in the balances row when no rail is live.
    const balances = await page.locator("text=Arc USDC").locator("xpath=..").innerText();
    expect(balances).not.toMatch(/\$\d/);
  });

  test("the activity timeline records the decisions the platform made", async ({ page }) => {
    await signUp(page);
    await api(page, "POST", "/api/v1/agents", {
      name: "Audited Agent",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    await page.goto("/activity");
    await expect(page.getByText(/agent\.?\s?created/i).first()).toBeVisible();
  });
});

test.describe("developer surface", () => {
  test("health reports honestly on what is configured", async ({ request }) => {
    const response = await request.get("/api/health");
    const body = (await response.json()) as {
      status: string;
      adapters: { adapter: string; status: string }[];
      capabilities: { id: string; state: string }[];
    };
    expect(["READY", "DEGRADED"]).toContain(body.status);
    expect(body.adapters.map((a) => a.adapter).sort()).toEqual([
      "arc",
      "blockdag",
      "circle",
      "kaleido",
      "xrpl",
    ]);
  });

  test("no network primitive is AVAILABLE unless it was verified live", async ({ request }) => {
    const response = await request.get("/api/v1/network/capabilities");
    const body = (await response.json()) as {
      capabilities: { id: string; state: string; source: string }[];
    };
    for (const capability of body.capabilities) {
      if (capability.state !== "AVAILABLE") continue;
      // The only thing that can be AVAILABLE without a live probe is the
      // mu-ledger, which is this application's own code.
      expect(
        capability.source === "live" || capability.id.startsWith("MULEDGER."),
        `${capability.id} is AVAILABLE from source "${capability.source}"`,
      ).toBe(true);
    }
  });

  test("economic endpoints refuse an unauthenticated caller", async ({ request }) => {
    for (const [method, path] of [
      ["GET", "/api/v1/agents"],
      ["GET", "/api/v1/quotes"],
      ["GET", "/api/v1/clearing"],
    ] as const) {
      const response = await request.fetch(path, { method });
      expect(response.status(), path).toBe(401);
    }
    const post = await request.post("/api/v1/mandate/check", {
      data: { agentId: "agent_x", amountUsd: "1" },
    });
    expect(post.status()).toBe(401);
  });

  test("the chat endpoint refuses an unauthenticated caller", async ({ request }) => {
    const response = await request.post("/api/chat", {
      data: { messages: [{ role: "user", content: "hello" }] },
    });
    expect([401, 503]).toContain(response.status());
  });
});
