/**
 * Account security.
 *
 * What is worth asserting here is that the page reads the *server's* view of
 * the account — the sessions it actually holds, whether the address is
 * confirmed — and that changing how the account is protected needs the
 * password, not merely a valid cookie.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function register(page: Page): Promise<string> {
  const email = `sec-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  return email;
}

test("the page is unreachable without a session", async ({ page }) => {
  await page.goto("/settings/security");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fsecurity/);
});

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("shows the account's real state and its live sessions", async ({ page }) => {
    const email = await register(page);
    await page.goto("/settings/security");

    const main = page.getByRole("main");
    await expect(main.getByText(email)).toBeVisible();
    // No mail provider is configured in this environment, so the address is
    // genuinely unconfirmed and the page says so rather than assuming.
    await expect(main.getByText("UNCONFIRMED")).toBeVisible();
    await expect(main.getByText("TWO-FACTOR OFF")).toBeVisible();

    // The session this browser is using is listed, and marked.
    await expect(main.getByText("this device")).toBeVisible();
    // It has no "End session" button: you cannot lock yourself out by accident.
    await expect(main.getByRole("button", { name: "End session" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "End every other session" })).toBeDisabled();
  });

  test("turning on two-factor requires the password, not just the cookie", async ({ page }) => {
    await register(page);
    await page.goto("/settings/security");

    await page.getByRole("button", { name: "Turn on two-factor" }).click();
    await expect(page.getByText(/A stolen session cookie must not be enough/i)).toBeVisible();

    await page.getByLabel("Password").fill("not-the-right-password");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // And the account is still unprotected, rather than half-enrolled.
    await page.goto("/settings/security");
    await expect(page.getByRole("main").getByText("TWO-FACTOR OFF")).toBeVisible();
  });

  test("offers passkeys, and explains why they are worth having", async ({ page }) => {
    await register(page);
    await page.goto("/settings/security");
    await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
    await expect(page.getByText(/cannot be phished/i).first()).toBeVisible();
  });
});
