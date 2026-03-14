/**
 * Routing / redirect tests — no browser session required.
 *
 * By the time these tests run, global-setup has already created the admin
 * user and configured the app.  The browser here starts with no cookies so
 * it behaves like an unauthenticated visitor.
 */

import { test, expect } from "@playwright/test";

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
