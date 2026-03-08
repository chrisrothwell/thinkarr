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

import { test, expect, request } from "@playwright/test";
import { BASE_URL } from "./global-setup";

// Seed messages via API to exhaust the rate limit without going through the UI
async function seedMessagesToLimit(sessionCookie: string, convId: string, count: number) {
  const ctx = await request.newContext({ baseURL: BASE_URL });

  for (let i = 0; i < count; i++) {
    await ctx.post("/api/chat", {
      headers: { Cookie: sessionCookie },
      // We can't easily seed raw DB messages through the API in E2E tests,
      // so we set the user's rate limit via the settings API instead.
    });
  }

  await ctx.dispose();
}

test.describe("Rate limit UI", () => {
  test("rate limit error appears inline when limit is exceeded", async ({ page, context }) => {
    await page.goto("/chat");

    // Lower the rate limit to 0 via settings API so the next message is blocked.
    // We call the admin settings endpoint directly.
    const cookies = await context.cookies();
    const sessionCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Get the current user id from the session
    const apiCtx = await request.newContext({ baseURL: BASE_URL });
    const sessionRes = await apiCtx.get("/api/auth/session", {
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
    await apiCtx.patch("/api/settings/users", {
      headers: { Cookie: sessionCookie },
      data: { userId, rateLimitMessages: 0, rateLimitPeriod: "day" },
    });
    await apiCtx.dispose();

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
