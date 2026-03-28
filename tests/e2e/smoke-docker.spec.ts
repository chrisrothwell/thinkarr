/**
 * Docker smoke tests
 *
 * A small suite run against the built Docker image to verify that the image
 * boots correctly and that the key infrastructure concerns are working:
 *
 *   - The container serves requests (routing/redirects work)
 *   - Pages render (Next.js standalone build is intact)
 *   - The Plex OAuth flow completes and a session cookie is issued
 *     (SECURE_COOKIES=false and PLEX_API_BASE env vars are injected correctly)
 *   - A chat round-trip succeeds (LLM baseUrl env var reaches the app)
 *
 * Application-logic coverage (title cards, rate-limit UI, conversation
 * history, etc.) is handled by the full suite in playwright.config.ts which
 * runs against the Next.js dev server on every PR.  There is no value in
 * repeating those tests here — the same JS runs in both environments.
 */

import { test, expect } from "@playwright/test";
import { ADMIN_AUTH_FILE } from "./global-setup-docker";

// ---------------------------------------------------------------------------
// Boot + routing (no session required)
// ---------------------------------------------------------------------------

test.describe("Boot and routing", () => {
  test("/ redirects unauthenticated visitors to /login", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.url()).toContain("/login");
  });

  test("/login renders the sign-in card", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in with plex/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Auth flow — verifies SECURE_COOKIES + PLEX_API_BASE injection
// ---------------------------------------------------------------------------

test.describe("Plex auth flow", () => {
  test("completes Plex OAuth and redirects to /chat", async ({ page }) => {
    await page.route("https://app.plex.tv/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" }),
    );

    await page.goto("/login");

    page.on("popup", async (popup) => {
      await popup.close();
    });

    await page.getByRole("button", { name: /sign in with plex/i }).click();

    // Mock returns a claimed token immediately; poll interval is 2 s
    await expect(page).toHaveURL(/\/(chat|settings)/, { timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Core chat round-trip — verifies LLM env var injection and session cookies
// ---------------------------------------------------------------------------

test.describe("Chat round-trip", () => {
  test.use({ storageState: ADMIN_AUTH_FILE });

  test("sends a message and receives a streaming LLM response", async ({ page }) => {
    await page.goto("/chat");

    await page.getByPlaceholder("Type a message...").fill("What is the answer?");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("message-user")).toBeVisible();
    await expect(page.getByTestId("message-assistant")).toContainText("Here is the answer", {
      timeout: 15_000,
    });
  });
});
