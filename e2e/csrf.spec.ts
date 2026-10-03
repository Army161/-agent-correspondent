/**
 * Cross-site request forgery.
 *
 * The API parses a JSON body regardless of Content-Type, so a cross-site
 * `<form enctype="text/plain">` can deliver a well-formed JSON body without a
 * CORS preflight. What stops it is that the session cookie is SameSite=Lax,
 * so a cross-site POST arrives without it. That alone does nothing against a
 * same-site attacker, so JSON routes also require Content-Type:
 * application/json, which a form cannot send. This test checks both layers,
 * with a legitimate request as the control.
 *
 * 127.0.0.1 and localhost are different sites, so one server can play both
 * the victim origin and the attacker origin.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const body = (await (await request.get("/api/health")).json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function agentNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const body = (await (await fetch("/api/v1/agents")).json()) as { agents?: { name: string }[] };
    return (body.agents ?? []).map((agent) => agent.name);
  });
}

/** Write a page at `origin` that auto-submits a text/plain "JSON" form to `target`. */
async function submitForgedForm(page: Page, origin: string, target: string, name: string): Promise<number> {
  await page.goto(`${origin}/legal/terms`);
  const answered = page.waitForResponse((response) => response.url() === target && response.request().method() === "POST");
  await page.evaluate(
    ([action, agentName]) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.enctype = "text/plain";
      form.action = action;
      // text/plain encodes as `name=value`; splitting the JSON at an `=` inside
      // a string value yields a valid JSON body.
      const input = document.createElement("input");
      input.name = `{"name":"${agentName}","model":"claude-sonnet-5","x":"`;
      input.value = `"}`;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    },
    [target, name] as const,
  );
  const status = (await answered).status();
  // A form submission is a navigation; let it land before the next goto.
  await page.waitForURL(target);
  return status;
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("ATTACK: a cross-site form cannot act with the victim's session", async ({ page, baseURL }) => {
    const victim = new URL(baseURL!);
    test.skip(victim.hostname !== "127.0.0.1", "needs a 127.0.0.1 base URL to have a distinct localhost site");
    const attacker = `${victim.protocol}//localhost:${victim.port}`;
    const target = `${victim.origin}/api/v1/agents`;

    await page.goto("/login?mode=register");
    await page.getByLabel("Your name").fill("CSRF Victim");
    await page.getByLabel("Email").fill(`csrf-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
    await page.getByLabel("Password").fill("correct-horse-battery-staple");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/onboarding");

    // Control: a legitimate JSON request with this session works, so the
    // refusals below are not just a broken session.
    const ok = await page.evaluate(async () => {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "legitimate", model: "claude-sonnet-5" }),
      });
      return response.status;
    });
    expect(ok).toBe(201);

    // Layer 1 -- SameSite=Lax: from another site the cookie is not sent.
    expect(await submitForgedForm(page, attacker, target, "cross-site-forgery")).toBe(401);

    // Layer 2 -- JSON content type required: even same-site (where the cookie
    // IS sent, e.g. from a compromised sibling subdomain) a form body is refused.
    expect(await submitForgedForm(page, victim.origin, target, "same-site-forgery")).toBe(400);

    await page.goto(`${victim.origin}/onboarding`);
    const names = await agentNames(page);
    expect(names).toContain("legitimate");
    expect(names).not.toContain("cross-site-forgery");
    expect(names).not.toContain("same-site-forgery");
  });
});
