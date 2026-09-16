/**
 * Public surface: the landing page, the ACOR page, and the claims on them.
 *
 * Several of these assertions exist to protect against a *regression in
 * honesty* rather than a regression in behaviour: a fabricated contract
 * address or an invented partnership claim is the most damaging thing this
 * site could ship, so it is asserted against directly.
 */

import { expect, test } from "@playwright/test";

test.describe("landing page", () => {
  test("renders the positioning, both calls to action, and the brand mark", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /Full-Stack Agent Chat OS for the Machine Economy/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Launch Agent OS/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /See pricing/i })).toBeVisible();
    await expect(page.locator("svg[aria-label='Agent Correspondent']").first()).toBeVisible();
  });

  test("carries every landing section", async ({ page }) => {
    await page.goto("/");
    for (const heading of [
      /AI agents can think/i,
      /One interface\. Multiple economic rails/i,
      /the kernel decides what is allowed/i,
      /Not every machine payment belongs onchain/i,
      /Cross-network architecture/i,
      /The token supports the product/i,
      /Build agents that can pay for things/i,
      /^Roadmap$/i,
      /Machines are becoming economic actors/i,
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("labels the chat panel as an illustration rather than live data", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Illustration — not live data/i)).toBeVisible();
  });

  test("states integration status without claiming partnership", async ({ page }) => {
    await page.goto("/");
    // The disclaimer is rendered from the capability manifest, not written into
    // the page, so it cannot be edited away independently of the statuses.
    await expect(page.getByText(/not claims of partnership/i)).toBeVisible();
    await expect(
      page.getByText(/not affiliated with, endorsed by, or sponsored by/i).first(),
    ).toBeVisible();
    // The prohibited claims must never appear as assertions. They may appear
    // inside a denial ("No guaranteed yield or return"), so each occurrence is
    // required to sit in a negating context rather than being banned outright.
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const claim of [
      "guaranteed return",
      "guaranteed yield",
      "official partner",
      "in partnership with",
      "backed by nvidia",
      "regulatory approval",
      "dividend",
      "profit",
    ]) {
      let index = body.indexOf(claim);
      while (index !== -1) {
        const preceding = body.slice(Math.max(0, index - 40), index);
        expect(
          /\b(no|not|never|without|carries no|promises no)\b[^.]*$/.test(preceding),
          `"${claim}" appears on the landing page outside a denial: …${preceding}[${claim}]…`,
        ).toBe(true);
        index = body.indexOf(claim, index + claim.length);
      }
    }
  });

  test("has correct SEO metadata and social image", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Agent Correspondent — Full-Stack Agent Chat OS/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /agentcorrespondent\.com/,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /og-brand\.png/,
    );
  });

  test("serves every brand asset", async ({ request }) => {
    for (const asset of [
      "/logo-mark.svg",
      "/logo-full.svg",
      "/logo-dark.svg",
      "/logo-square.png",
      "/favicon.svg",
      "/og-brand.png",
      "/banner-x.png",
    ]) {
      const response = await request.get(asset);
      expect(response.status(), asset).toBe(200);
    }
  });
});

test.describe("ACOR token page", () => {
  test("refuses to show a contract address before one is deployed", async ({ page }) => {
    await page.goto("/acor");
    await expect(page.getByText(/Contract not yet deployed/i)).toBeVisible();

    // No 0x-prefixed 40-hex string may appear anywhere on this page. A
    // fabricated address here is how people lose money.
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  test("carries the risk disclosures and denies the claims it must deny", async ({ page }) => {
    await page.goto("/acor");
    await expect(page.getByRole("heading", { name: /Risk disclosures/i })).toBeVisible();
    for (const disclaimer of [
      /Equity or any ownership interest/i,
      /Dividends, revenue share, or profit participation/i,
      /Guaranteed yield, return, or token appreciation/i,
      /Redemption rights/i,
      /Exposure to NVIDIA/i,
      /Approval, registration or endorsement by any regulator/i,
    ]) {
      await expect(page.getByText(disclaimer)).toBeVisible();
    }
  });

  test("explains how to verify, and lists only official links", async ({ page }) => {
    await page.goto("/acor");
    await expect(page.getByRole("heading", { name: /How to verify/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /x\.com\/AgentCorrespondent/i })).toBeVisible();
  });
});

test.describe("navigation", () => {
  test("every required route responds", async ({ page }) => {
    for (const route of [
      "/",
      "/chat",
      "/agents",
      "/jobs",
      "/wallets",
      "/clearing",
      "/activity",
      "/developers",
      "/acor",
      "/settings",
      "/security",
    ]) {
      const response = await page.goto(route);
      expect(response?.status(), route).toBe(200);
    }
  });

  test("an unknown route renders the 404 rather than crashing", async ({ page }) => {
    const response = await page.goto("/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /Route not found/i })).toBeVisible();
  });
});
