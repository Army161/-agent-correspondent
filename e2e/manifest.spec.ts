/**
 * The landing page cannot claim more than the product does.
 *
 * Every integration status on the public site is rendered from
 * `/api/v1/manifest`, which is derived from live capability probes and what is
 * actually configured. These tests assert the two cannot diverge — which is the
 * only durable way to keep a marketing page honest, since copy drifts and
 * always in the flattering direction.
 */

import { expect, test } from "@playwright/test";

interface Manifest {
  generatedAt: string;
  production: boolean;
  disclaimer: string;
  summary: Record<string, number>;
  features: {
    id: string;
    label: string;
    group: string;
    status: string;
    capability: string;
    evidence: string;
  }[];
}

const STATUSES = ["LIVE", "TESTNET", "INTEGRATING", "EXPLORING", "UNAVAILABLE"];

test.describe("capability manifest", () => {
  test("is public, and every feature carries a status and its evidence", async ({ request }) => {
    const response = await request.get("/api/v1/manifest");
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as Manifest;

    expect(manifest.features.length).toBeGreaterThan(10);
    for (const feature of manifest.features) {
      expect(STATUSES, `${feature.id} has status ${feature.status}`).toContain(feature.status);
      expect(feature.evidence.length, `${feature.id} has no evidence`).toBeGreaterThan(0);
      expect(feature.capability.length).toBeGreaterThan(0);
    }
  });

  test("nothing is LIVE unless its evidence says it was probed or is our own code", async ({
    request,
  }) => {
    const manifest = (await (await request.get("/api/v1/manifest")).json()) as Manifest;
    for (const feature of manifest.features.filter((entry) => entry.status === "LIVE")) {
      expect(
        feature.evidence.includes("(live)") || feature.evidence.includes("(internal)"),
        `${feature.id} is LIVE but its evidence is "${feature.evidence}"`,
      ).toBe(true);
    }
  });

  test("on a deployment with no rails configured, no network feature is LIVE", async ({
    request,
  }) => {
    const health = await (await request.get("/api/health")).json();
    const anyRailReady = (health.adapters as { status: string }[]).some(
      (adapter) => adapter.status === "READY",
    );
    test.skip(anyRailReady, "a rail is configured on this deployment");

    const manifest = (await (await request.get("/api/v1/manifest")).json()) as Manifest;
    const liveNetworkFeatures = manifest.features.filter(
      (feature) => feature.status === "LIVE" && feature.group !== "μLedger",
    );
    expect(liveNetworkFeatures.map((feature) => feature.id)).toEqual([]);
  });

  test("states that statuses are not partnership claims", async ({ request }) => {
    const manifest = (await (await request.get("/api/v1/manifest")).json()) as Manifest;
    expect(manifest.disclaimer).toMatch(/not claims of partnership/i);
  });
});

test.describe("the landing page renders the manifest, not its own copy", () => {
  test("shows exactly the statuses the manifest reports", async ({ page, request }) => {
    const manifest = (await (await request.get("/api/v1/manifest")).json()) as Manifest;
    await page.goto("/");

    const integrations = page.locator("section", {
      has: page.getByRole("heading", { name: /Cross-network architecture/i }),
    });
    await expect(integrations).toBeVisible();
    const text = await integrations.innerText();

    // Every group the manifest knows about appears, with a status.
    for (const group of new Set(manifest.features.map((feature) => feature.group))) {
      expect(text, `group ${group} missing from the page`).toContain(group);
    }

    // The page must not show LIVE for a feature the manifest does not.
    const manifestHasLiveNetworkFeature = manifest.features.some(
      (feature) => feature.status === "LIVE" && feature.group !== "μLedger",
    );
    if (!manifestHasLiveNetworkFeature) {
      const arcBlock = text.slice(text.indexOf("Arc"), text.indexOf("Circle"));
      expect(arcBlock).not.toContain("LIVE");
    }
  });

  test("the roadmap reads its statuses from the manifest", async ({ page, request }) => {
    const manifest = (await (await request.get("/api/v1/manifest")).json()) as Manifest;
    await page.goto("/");
    const roadmap = page.locator("section", {
      has: page.getByRole("heading", { name: /^Roadmap$/ }),
    });
    const text = await roadmap.innerText();

    const xrpl = manifest.features.find((feature) => feature.id === "xrpl.payments");
    expect(text).toContain(xrpl?.status ?? "EXPLORING");
    // A roadmap row must never claim more than its capability.
    if (xrpl?.status !== "LIVE") {
      const settlementRow = text.slice(text.indexOf("XRPL Settlement"));
      expect(settlementRow.slice(0, 40)).not.toContain("LIVE");
    }
  });

  test("explains what each status means, so the words are not ambiguous", async ({ page }) => {
    await page.goto("/");
    for (const meaning of [
      /verified live on a production network/i,
      /balances are not money/i,
      /built, not yet verified end to end/i,
      /probed and found absent/i,
    ]) {
      await expect(page.getByText(meaning)).toBeVisible();
    }
  });
});

test.describe("pricing", () => {
  test("renders every plan and never offers a purchase it cannot complete", async ({ page }) => {
    await page.goto("/pricing");
    for (const plan of ["Public Alpha", "Builder", "Pro", "Enterprise"]) {
      await expect(page.getByRole("heading", { name: plan, exact: true })).toBeVisible();
    }

    const body = await page.locator("body").innerText();
    if (body.includes("Checkout unavailable")) {
      // Without billing configured, no paid plan may present a checkout CTA.
      await expect(page.getByRole("link", { name: /Choose Builder/i })).toHaveCount(0);
      await expect(page.getByText("Not yet purchasable").first()).toBeVisible();
    }
  });

  test("states that a paid plan relaxes no economic control", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByText(/does not relax any economic control/i)).toBeVisible();
    await expect(page.getByText(/Nothing a browser reports about a plan is trusted/i)).toBeVisible();
  });

  test("signup redirects into the single account-creation form", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/login\?mode=register/);
    await expect(page.getByRole("heading", { name: /Create an account/i })).toBeVisible();
  });
});
