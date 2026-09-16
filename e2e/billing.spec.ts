/**
 * Billing, through the browser and the public API.
 *
 * The webhook's signature verification is covered exhaustively by unit tests,
 * which can forge headers precisely. What is tested here is the part a unit
 * test cannot reach: that the page reports a plan read from the database, that
 * an unauthenticated caller cannot start a checkout, and that a plan limit is
 * enforced by the server rather than by the form.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function register(page: Page): Promise<string> {
  const email = `billing-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  return email;
}

test("an unauthenticated caller cannot start a checkout", async ({ request }) => {
  const response = await request.post("/api/billing/checkout", {
    data: { planId: "builder", period: "monthly" },
  });
  expect(response.status()).toBe(401);
});

test("a forged webhook is refused", async ({ request }) => {
  const response = await request.post("/api/billing/webhook", {
    headers: { "paddle-signature": "ts=1789600000;h1=" + "0".repeat(64) },
    data: { event_id: "evt_forged", event_type: "subscription.activated", data: { id: "sub_x" } },
  });
  // 401 when a secret is configured, 503 when one is not. Never 200.
  expect([401, 503]).toContain(response.status());
});

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("a new organization is on the default plan and says where that came from", async ({
    page,
  }) => {
    await register(page);
    await page.goto("/billing");
    const main = page.getByRole("main");
    await expect(main.getByText("Public Alpha").first()).toBeVisible();
    await expect(main.getByText(/No paid subscription is on file/i)).toBeVisible();
    await expect(
      main.getByText(/proves that a browser reached a success page/i),
    ).toBeVisible();
  });

  test("the plan's agent limit is enforced by the server, not the form", async ({ page }) => {
    await register(page);

    const statuses = await page.evaluate(async () => {
      const results: number[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const response = await fetch("/api/v1/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `Agent ${index}`,
            provider: "anthropic",
            model: "claude-sonnet-5",
          }),
        });
        results.push(response.status);
      }
      return results;
    });

    // The default plan includes three.
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses[3]).toBe(402);
  });
});
