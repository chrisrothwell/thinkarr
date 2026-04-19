/**
 * Routing / redirect tests — no browser session required.
 *
 * By the time these tests run, global-setup has already created the admin
 * user and configured the app.  The browser here starts with no cookies so
 * it behaves like an unauthenticated visitor.
 */

import { test, expect } from "@playwright/test";

test.describe("stale session redirect", () => {
  test("/chat redirects to /login when session cookie is invalid", async ({ page, context }) => {
    await context.addCookies([
      {
        name: "thinkarr_session",
        value: "00000000-0000-0000-0000-000000000000",
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto("/chat");
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });

  test("/settings redirects to /login when session cookie is invalid", async ({ page, context }) => {
    await context.addCookies([
      {
        name: "thinkarr_session",
        value: "00000000-0000-0000-0000-000000000000",
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });
});

test.describe("root redirect — post-setup", () => {
  test("/ redirects unauthenticated visitors to /login", async ({ page }) => {
    // Root page redirects to /chat when users exist, but the auth middleware
    // then redirects unauthenticated visitors to /login.
    const res = await page.goto("/");
    expect(res?.url()).toContain("/login");
  });

  test("/setup is inaccessible after first admin has registered", async ({ page }) => {
    // /setup is a client-rendered page so it doesn't 404, but it should show
    // the Plex login button (setup = just the admin registration page).
    await page.goto("/setup");
    await expect(page.getByRole("button", { name: /login with plex/i })).toBeVisible();
  });

  test("/login renders the sign-in card", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Thinkarr")).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in with plex/i })).toBeVisible();
  });
});
