/**
 * Title card E2E tests
 *
 * Verifies that the LLM can call the display_titles tool and that the
 * resulting title cards render correctly in the chat UI, including:
 *
 *   - A single "Available" title card with a "Watch Now" button
 *   - A single "Not Requested" title card with a "Request" button
 *   - Successful request submission showing the "Requested" badge
 *   - Multiple titles rendered as a scrollable carousel
 *
 * The LLM mock server (helpers/mock-servers.ts) is configured to return
 * display_titles tool calls when the user message contains specific trigger
 * phrases (TRIGGER_* constants).  The orchestrator executes the tool
 * server-side and passes the result back to the LLM for a follow-up text
 * response, so the full tool-call loop is exercised end-to-end.
 */

import { test, expect } from "@playwright/test";
import {
  TRIGGER_AVAILABLE,
  TRIGGER_UNAVAILABLE,
  TRIGGER_MULTIPLE,
  TRIGGER_PENDING,
  TRIGGER_NO_EXTERNAL_IDS,
  TRIGGER_NO_EXTERNAL_IDS_TV,
  TRIGGER_MISSING_MEDIA_TYPE,
} from "./helpers/mock-servers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a chat message and wait for the LLM response to finish streaming. */
async function sendMessage(page: import("@playwright/test").Page, message: string) {
  await page.getByPlaceholder("Type a message...").fill(message);
  await page.keyboard.press("Enter");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Title card — available movie", () => {
  test("renders a title card with 'Available' status and Watch Now button", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_AVAILABLE);

    // Wait for the assistant message (text follow-up after tool call)
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    // A title card should have appeared inside the assistant bubble
    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Movie title and year rendered correctly
    await expect(card).toContainText("Ghostbusters");
    await expect(card).toContainText("1984");

    // Status badge shows "Available"
    await expect(card.getByTestId("title-status")).toHaveText("Available");

    // Watch Now button is visible (plexKey + machineId from mock)
    await expect(card.getByTestId("watch-now-button")).toBeVisible();

    // Request button should NOT appear for an available title
    await expect(card.getByTestId("request-button")).not.toBeVisible();
  });

  test("Watch Now button links to app.plex.tv with the correct key", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_AVAILABLE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const watchNow = page.getByTestId("watch-now-button").first();
    await expect(watchNow).toBeVisible({ timeout: 10_000 });

    const href = await watchNow.getAttribute("href");
    expect(href).toContain("app.plex.tv");
    expect(href).toContain("e2e-machine-id");
    expect(href).toContain(encodeURIComponent("/library/metadata/100"));
  });
});

test.describe("Title card — not_requested movie", () => {
  test("renders a title card with 'Not Requested' status and Request button", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_UNAVAILABLE);

    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    await expect(card).toContainText("Inception");
    await expect(card).toContainText("2010");

    // Status badge shows "Not Requested"
    await expect(card.getByTestId("title-status")).toHaveText("Not Requested");

    // Request button present (overseerrId is set)
    await expect(card.getByTestId("request-button")).toBeVisible();

    // Watch Now button absent (not available in Plex)
    await expect(card.getByTestId("watch-now-button")).not.toBeVisible();
  });

  test("clicking Request submits to Overseerr and shows Requested badge", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_UNAVAILABLE);

    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    // Wait for the post-stream conversation reload (finally block in use-chat.ts) to
    // complete before clicking Request.  If we click while the reload is in-flight,
    // setToolCalls(new Map()) remounts the TitleCard and the request-success state
    // update goes to the now-unmounted component, causing a flaky failure.
    await page.waitForLoadState("networkidle");

    const card = page.getByTestId("title-card").first();
    const requestBtn = card.getByTestId("request-button");
    await expect(requestBtn).toBeVisible({ timeout: 10_000 });

    await requestBtn.click();

    // After a successful request the button is replaced by the "Requested" badge
    await expect(card.getByTestId("request-success")).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("request-button")).not.toBeVisible();
  });

  test("Requested badge survives conversation reload (issue #338)", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_UNAVAILABLE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");

    const card = page.getByTestId("title-card").first();
    await card.getByTestId("request-button").click();
    await expect(card.getByTestId("request-success")).toBeVisible({ timeout: 10_000 });

    // Reload the page — the Requested badge must still be shown
    await page.reload();
    await page.waitForLoadState("networkidle");

    const reloadedCard = page.getByTestId("title-card").first();
    await expect(reloadedCard.getByTestId("request-success")).toBeVisible({ timeout: 10_000 });
    await expect(reloadedCard.getByTestId("request-button")).not.toBeVisible();
  });
});

test.describe("Title card — multiple titles (carousel)", () => {
  test("renders a scrollable carousel when more than one title is returned", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_MULTIPLE);

    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    // The carousel container should be present
    await expect(page.getByTestId("title-carousel")).toBeVisible({ timeout: 10_000 });

    // All three title cards should exist in the DOM
    await expect(page.getByTestId("title-card")).toHaveCount(3, { timeout: 10_000 });

    // Verify all three titles rendered
    await expect(page.getByTestId("title-carousel")).toContainText("Movie Alpha");
    await expect(page.getByTestId("title-carousel")).toContainText("Movie Beta");
    await expect(page.getByTestId("title-carousel")).toContainText("Show Gamma");
  });

  test("carousel shows correct status badges for each card", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_MULTIPLE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("title-carousel")).toBeVisible({ timeout: 10_000 });

    const cards = page.getByTestId("title-card");
    await expect(cards).toHaveCount(3, { timeout: 10_000 });

    // Statuses: available, pending, not_requested
    await expect(cards.nth(0).getByTestId("title-status")).toHaveText("Available");
    await expect(cards.nth(1).getByTestId("title-status")).toHaveText("Pending");
    await expect(cards.nth(2).getByTestId("title-status")).toHaveText("Not Requested");
  });
});

test.describe("Title card — pending TV show", () => {
  test("renders 'More Info' button but no Request button for pending items", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_PENDING);

    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    await expect(card).toContainText("Star City");

    // Status badge shows "Pending"
    await expect(card.getByTestId("title-status")).toHaveText("Pending");

    // More Info button is visible (imdbId is set)
    await expect(card.getByTestId("more-info-button")).toBeVisible();

    // More Info links to IMDb when imdbId is present
    const moreInfoHref = await card.getByTestId("more-info-button").getAttribute("href");
    expect(moreInfoHref).toContain("imdb.com/title/tt32140872");

    // Request button must NOT appear — item is already requested
    await expect(card.getByTestId("request-button")).not.toBeVisible();

    // Watch Now button absent — not in Plex yet
    await expect(card.getByTestId("watch-now-button")).not.toBeVisible();
  });
});

test.describe("Title card — summary and rating", () => {
  test("displays summary and star rating when provided", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_AVAILABLE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Summary text (set in mock)
    await expect(card).toContainText("Who ya gonna call?");

    // Rating visible (8.5 → "8.5")
    await expect(card).toContainText("8.5");
  });
});

test.describe("Title card — More Info always visible", () => {
  test("shows More Info even when no imdbId or overseerrId (falls back to Google search)", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_NO_EXTERNAL_IDS);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Local Favorite");

    // More Info button is always visible regardless of external IDs
    const moreInfo = card.getByTestId("more-info-button");
    await expect(moreInfo).toBeVisible();

    // Falls back to Google search URL
    const href = await moreInfo.getAttribute("href");
    expect(href).toContain("google.com/search");
    expect(href).toContain("Local%20Favorite");
  });

  test("TV season card without external IDs uses showTitle (not 'Show — Season N') in Google search", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_NO_EXTERNAL_IDS_TV);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    const moreInfo = card.getByTestId("more-info-button");
    await expect(moreInfo).toBeVisible();

    // Must search by showTitle ("Euphoria (US)"), not the full "Euphoria (US) — Season 3"
    const href = await moreInfo.getAttribute("href");
    expect(href).toContain("google.com/search");
    expect(href).toContain("Euphoria");
    expect(href).not.toContain("Season");
  });

  test("shows More Info with IMDB link when imdbId is present", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_PENDING);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    const moreInfo = card.getByTestId("more-info-button");
    await expect(moreInfo).toBeVisible({ timeout: 10_000 });

    const href = await moreInfo.getAttribute("href");
    expect(href).toContain("imdb.com/title/tt32140872");
  });

  test("shows More Info with TMDB direct page when overseerrId is present (no imdbId)", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_UNAVAILABLE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    const moreInfo = card.getByTestId("more-info-button");
    await expect(moreInfo).toBeVisible({ timeout: 10_000 });

    const href = await moreInfo.getAttribute("href");
    expect(href).toContain("themoviedb.org/movie/27205");
  });
});

test.describe("Title card — overseerrMediaType inference", () => {
  test("shows Request button when overseerrId present but overseerrMediaType omitted", async ({ page }) => {
    await page.goto("/chat");

    await sendMessage(page, TRIGGER_MISSING_MEDIA_TYPE);
    await expect(page.getByTestId("message-assistant")).toBeVisible({ timeout: 20_000 });

    const card = page.getByTestId("title-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Unknown Type Show");

    // Request button must appear even though overseerrMediaType was not in the tool call
    await expect(card.getByTestId("request-button")).toBeVisible();

    // More Info should also be visible (TMDB link built from inferred overseerrMediaType)
    const moreInfo = card.getByTestId("more-info-button");
    await expect(moreInfo).toBeVisible();
    const href = await moreInfo.getAttribute("href");
    expect(href).toContain("themoviedb.org/tv/55555");
  });
});
