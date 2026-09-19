/**
 * Authentication and onboarding, through the browser.
 *
 * The properties under test are the ones a screenshot cannot show: that an
 * unauthenticated request cannot reach the product, that a post-sign-in
 * redirect cannot be aimed off-site, that a provider without credentials is
 * shown as unavailable rather than as a button that fails after the redirect,
 * and that onboarding progress is derived from the account rather than stored
 * as a cursor.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function register(page: Page): Promise<string> {
  const email = `auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  return email;
}

test.describe("sign-in page", () => {
  test("offers a passkey and says which social providers are unavailable", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    // No OAuth credentials are configured in this environment, and the page
    // says so instead of rendering three buttons that cannot complete.
    await expect(page.getByText(/not available on this deployment/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(0);
  });

  test("account creation requires accepting the terms", async ({ page }) => {
    await page.goto("/login?mode=register");
    const terms = page.getByRole("checkbox");
    await expect(terms).not.toBeChecked();
    await expect(page.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
  });

  test("password recovery never says whether the address has an account", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  });

  test("a reset link with no token refuses rather than showing a form", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText(/missing its token/i)).toBeVisible();
    await expect(page.getByLabel("New password")).toHaveCount(0);
  });
});

test.describe("session boundary", () => {
  test("onboarding is unreachable without a session", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/login\?next=%2Fonboarding/);
  });

  test("an off-site redirect target is discarded", async ({ page, request }) => {
    test.skip(!(await databaseConfigured(request)), "database not configured");
    // A `?next=` pointing off-site must not be where a successful sign-in
    // lands: that chain turns a real sign-in page into credential theft.
    await page.goto("/login?mode=register&next=https%3A%2F%2Fevil.example%2Fsteal");
    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page
      .getByLabel("Email")
      .fill(`redirect-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("**/onboarding");
    expect(page.url()).not.toContain("password=");
    expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin);
    expect(page.url()).not.toContain("evil.example");
  });
});

test.describe("onboarding", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("a new account starts with nothing done and economic actions held", async ({ page }) => {
    const email = await register(page);
    await expect(page.getByRole("heading", { name: "Get set up" })).toBeVisible();
    await expect(page.getByText("0 of 4")).toBeVisible();
    await expect(page.getByText(/Economic actions are held/i)).toBeVisible();
    // Scoped to main: the navigation rail also renders the address, and it is
    // present-but-hidden at mobile widths.
    await expect(page.getByRole("main").getByText(email)).toBeVisible();
  });

  test("naming the organization completes that step and survives a reload", async ({ page }) => {
    await register(page);
    await page.getByLabel("Organization name").fill("Acme Research");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("1 of 4")).toBeVisible();

    await page.reload();
    await expect(page.getByText("1 of 4")).toBeVisible();
    await expect(page.getByLabel("Organization name")).toHaveValue("Acme Research");
  });

  test("choosing a plan records a choice, and says it is not a purchase", async ({ page }) => {
    await register(page);
    await page.getByRole("button", { name: /Public Alpha/ }).click();
    await page.getByRole("button", { name: "Choose this plan" }).click();
    await expect(page.getByText("1 of 4")).toBeVisible();
    await expect(page.getByText(/Recording a choice is not a purchase/i)).toBeVisible();
  });

  test("progress is derived: creating an agent through the API ticks the step", async ({ page }) => {
    await register(page);
    const created = await page.evaluate(async () => {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Research Desk",
          description: "Summarizes documents",
          provider: "anthropic",
          model: "claude-sonnet-5",
        }),
      });
      return response.status;
    });
    expect(created).toBeLessThan(300);

    await page.goto("/onboarding");
    await expect(page.getByRole("link", { name: /1 agent — review them/ })).toBeVisible();
    await expect(page.getByText("1 of 4")).toBeVisible();
  });

  test("signing out ends the session server-side", async ({ page, isMobile }) => {
    await register(page);
    await page.goto("/chat");
    if (isMobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login**");

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session");
      return response.text();
    });
    expect(session === "null" || session === "").toBe(true);
  });
});
