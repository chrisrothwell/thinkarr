/**
 * Rate limit UI tests
 *
 * Uses the admin session but seeds messages via the API to push the user over
 * their rate limit, then verifies the UI shows the correct inline error rather
 * than a broken page or silent failure.
 *
 * The rate limit is tested at two levels:
 *   1. API level — already covered in src/__tests__/api/chat.test.ts
 *   2. UI level (here) — the error appears inline in the chat, not as a crash
 */

import { test, expect } from "@playwright/test";

test.describe("Rate limit UI", () => {
  test.afterEach(async ({ context, request }) => {
    // Reset the rate limit back to the default (100) so subsequent tests are
    // not affected by the 0-message limit set during the test.
    const cookies = await context.cookies();
    const sessionCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const sessionRes = await request.get("/api/auth/session", {
      headers: { Cookie: sessionCookie },
    });
    const { data: sessionData } = await sessionRes.json();
    const userId = sessionData?.user?.id;

    if (userId) {
      await request.patch("/api/settings/users", {
        headers: { Cookie: sessionCookie },
        data: { userId, rateLimitMessages: 100, rateLimitPeriod: "day" },
      });
    }
  });

  test("rate limit error appears inline when limit is exceeded", async ({ page, context, request }) => {
    await page.goto("/chat");

    // Lower the rate limit to 0 via settings API so the next message is blocked.
    // We call the admin settings endpoint directly.
    const cookies = await context.cookies();
    const sessionCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Get the current user id from the session
    const sessionRes = await request.get("/api/auth/session", {
      headers: { Cookie: sessionCookie },
    });
    const { data: sessionData } = await sessionRes.json();
    const userId = sessionData?.user?.id;

    if (!userId) {
      // Session expired between global setup and this test — skip gracefully
      test.skip();
      return;
    }

    // Set rate limit to 0 messages/day so the very next chat message is blocked
    await request.patch("/api/settings/users", {
      headers: { Cookie: sessionCookie },
      data: { userId, rateLimitMessages: 0, rateLimitPeriod: "day" },
    });

    // Now send a chat message — it should be blocked
    await page.getByPlaceholder("Type a message...").fill("This should be rate limited");
    await page.keyboard.press("Enter");

    // The error is delivered as an SSE event and displayed inline in the chat,
    // NOT as a page crash or network error.
    await expect(page.getByText(/session limit/i)).toBeVisible({ timeout: 10_000 });

    // The chat input should still be available (not broken)
    await expect(page.getByPlaceholder("Type a message...")).toBeVisible();
  });
});
