/**
 * Organization API keys.
 *
 * What only exists in the running system: that an issued key actually
 * authenticates the public API (and the SDK built on it), that it is shown
 * once and never listed back, that a key cannot mint further keys, that
 * revocation takes effect on the very next request, and that one
 * organization cannot revoke another's key.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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

async function signUp(page: Page): Promise<void> {
  const email = `apikey-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Key Holder");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

/** A cookieless request, so only the bearer key can authenticate it. */
function withKey(request: APIRequestContext, key: string) {
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  return {
    get: (path: string) => request.get(path, { headers }),
    post: (path: string, data: unknown) => request.post(path, { headers, data }),
    delete: (path: string) => request.delete(path, { headers }),
  };
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("an issued key authenticates the API, is shown once, and stops working when revoked", async ({
    page,
    playwright,
  }) => {
    await signUp(page);
    const issued = await api(page, "POST", "/api/v1/api-keys", { name: "CI pipeline" });
    expect(issued.status).toBe(201);
    const key = issued.json.key as string;
    const keyId = issued.json.keyId as string;
    expect(key).toMatch(/^acor_sk_[0-9a-f]{64}$/);

    // Listing never returns the key itself.
    const listed = await api(page, "GET", "/api/v1/api-keys");
    expect(JSON.stringify(listed.json)).not.toContain(key);
    const rows = listed.json.keys as { id: string; prefix: string; revokedAt: string | null }[];
    expect(rows.find((row) => row.id === keyId)?.prefix).toBe(key.slice(0, 14));

    // A fresh, cookieless context: only the key can authenticate it.
    const bare = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const client = withKey(bare, key);
      const created = await client.post("/api/v1/agents", { name: "Via key", model: "claude-sonnet-5" });
      expect(created.status()).toBe(201);

      // ATTACK: a key cannot mint another key.
      const minted = await client.post("/api/v1/api-keys", { name: "persistence" });
      expect(minted.status()).toBe(403);
      expect(((await minted.json()) as { error: string }).error).toBe("SESSION_REQUIRED");

      // Revoke from the session; the very next keyed request is refused.
      const revoked = await api(page, "DELETE", `/api/v1/api-keys/${keyId}`);
      expect(revoked.status).toBe(200);
      expect((await client.get("/api/v1/agents")).status()).toBe(401);

      // Revoking twice is not a silent success.
      expect((await api(page, "DELETE", `/api/v1/api-keys/${keyId}`)).status).toBe(404);
    } finally {
      await bare.dispose();
    }
  });

  test("a key that knows it leaked can revoke itself", async ({ page, playwright }) => {
    await signUp(page);
    const issued = await api(page, "POST", "/api/v1/api-keys", { name: "leaky" });
    const key = issued.json.key as string;
    const bare = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const client = withKey(bare, key);
      expect((await client.delete(`/api/v1/api-keys/${issued.json.keyId as string}`)).status()).toBe(200);
      expect((await client.get("/api/v1/agents")).status()).toBe(401);
    } finally {
      await bare.dispose();
    }
  });

  test("ATTACK: one organization cannot revoke another's key", async ({ page }) => {
    await signUp(page);
    const issued = await api(page, "POST", "/api/v1/api-keys", { name: "victim" });
    const keyId = issued.json.keyId as string;

    await page.evaluate(async () => {
      await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    });
    await signUp(page);
    expect((await api(page, "DELETE", `/api/v1/api-keys/${keyId}`)).status).toBe(404);
  });

  test("the developers page issues a key and shows it exactly once", async ({ page }) => {
    await signUp(page);
    await page.goto("/developers");
    await page.getByLabel("Key name").fill("From the UI");
    await page.getByRole("button", { name: "Issue key" }).click();
    const shown = page.getByTestId("issued-api-key");
    await expect(shown).toHaveText(/^acor_sk_[0-9a-f]{64}$/);
    const key = (await shown.textContent()) ?? "";

    await page.reload();
    await expect(page.getByText("From the UI")).toBeVisible();
    await expect(page.getByTestId("issued-api-key")).toHaveCount(0);
    expect(await page.content()).not.toContain(key);

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("REVOKED")).toBeVisible();
  });
});
