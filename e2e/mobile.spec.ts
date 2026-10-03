/**
 * Mobile layout.
 *
 * The specific failure being guarded against is horizontal overflow: a
 * financial table that scrolls sideways on a phone is unreadable, and it is
 * the easiest thing to break without noticing on a desktop.
 */

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("landing page fits the viewport with no horizontal scroll", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("heading", { name: /Full-Stack Agent Chat OS/i }),
  ).toBeVisible();
});

test("app routes fit the viewport and expose the mobile navigation", async ({ page }) => {
  for (const route of ["/chat", "/agents", "/wallets", "/clearing", "/acor", "/developers"]) {
    await page.goto(route);
    // Measured against the device's screen width as well as clientWidth: under
    // mobile emulation Chromium widens the layout viewport to fit overflowing
    // content, so clientWidth grows with the bug and hides it.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        Math.min(document.documentElement.clientWidth, window.screen.width),
    );
    expect(overflow, `${route} overflows horizontally`).toBeLessThanOrEqual(1);
  }

  await page.goto("/chat");
  const toggle = page.getByRole("button", { name: /Toggle navigation/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("link", { name: "Clearing" })).toBeVisible();
});
