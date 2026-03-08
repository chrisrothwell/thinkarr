/**
 * Plex login flow — end-to-end
 *
 * The mock Plex server (started in global-setup) returns a claimed auth token
 * on the very first poll, so authentication completes after the 2-second poll
 * interval without any real user interaction.
 *
 * The popup that the login page opens is stubbed by page.route() so it loads
 * instantly and doesn't block the test.
 */

import { test, expect, Page } from "@playwright/test";

// Stub the Plex auth popup — the popup URL is the real app.plex.tv page;
// we intercept it so Playwright doesn't try to load the external site.
async function stubPlexPopup(page: Page) {
  await page.route("https://app.plex.tv/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" }),
  );
}

test.describe("Plex login flow from /login", () => {
  test("shows the Sign in with Plex button", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in with plex/i })).toBeVisible();
  });

  test("transitions to waiting state after clicking Sign in with Plex", async ({ page }) => {
    await stubPlexPopup(page);
    await page.goto("/login");

    // Allow popup creation (don't block it)
    page.on("popup", async (popup) => {
      await popup.close();
    });

    await page.getByRole("button", { name: /sign in with plex/i }).click();

    // The page enters the "waiting" state while polling Plex
    await expect(page.getByText(/complete sign-in in the plex popup/i)).toBeVisible();
  });

  test("redirects to /chat after successful Plex login", async ({ page }) => {
    await stubPlexPopup(page);
    await page.goto("/login");

    page.on("popup", async (popup) => {
      await popup.close();
    });

    await page.getByRole("button", { name: /sign in with plex/i }).click();

    // Poll interval is 2 s — wait up to 15 s for the redirect
    await expect(page).toHaveURL(/\/(chat|settings)/, { timeout: 15_000 });
  });

  test("Cancel button returns to the idle state", async ({ page }) => {
    await stubPlexPopup(page);
    await page.goto("/login");

    page.on("popup", async (popup) => {
      await popup.close();
    });

    await page.getByRole("button", { name: /sign in with plex/i }).click();
    await expect(page.getByText(/complete sign-in/i)).toBeVisible();

    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByRole("button", { name: /sign in with plex/i })).toBeVisible();
  });
});

test.describe("Plex login flow from /setup (first-run)", () => {
  test("shows Login with Plex button on the setup page", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("button", { name: /login with plex/i })).toBeVisible();
  });

  test("setup page shows Server Administrator note", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByText(/server administrator/i)).toBeVisible();
  });
});
