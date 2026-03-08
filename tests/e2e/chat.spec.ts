/**
 * Chat feature tests — requires admin session (storageState: ADMIN_AUTH_FILE)
 *
 * Covers:
 *   - Chat interface renders correctly
 *   - New conversation is created when a message is sent
 *   - Streaming LLM response appears in the message list
 *   - Auto-title is generated and shown in the sidebar
 *   - Continuing a previous conversation loads its history
 *   - Deleting a conversation removes it from the sidebar
 */

import { test, expect } from "@playwright/test";

// The mock LLM always responds: "Here is the answer."
const MOCK_RESPONSE = "Here is the answer.";

test.describe("Chat interface", () => {
  test("chat page renders the textarea and sidebar", async ({ page }) => {
    await page.goto("/chat");

    await expect(page.getByPlaceholder("Type a message...")).toBeVisible();
    await expect(page.getByRole("button", { name: /new chat/i })).toBeVisible();
  });

  test("send button is disabled when the input is empty", async ({ page }) => {
    await page.goto("/chat");
    // The send button is only enabled when there is text in the textarea.
    // It renders as an icon-only button, so we check its disabled state.
    const sendBtn = page.locator("button[disabled]").last();
    await expect(sendBtn).toBeVisible();
  });
});

test.describe("Sending a message", () => {
  test("sends a message and receives a streaming LLM response", async ({ page }) => {
    await page.goto("/chat");

    await page.getByPlaceholder("Type a message...").fill("What is the answer?");
    await page.keyboard.press("Enter");

    // User message appears immediately
    await expect(page.getByTestId("message-user")).toBeVisible();

    // Streaming response appears within a generous timeout
    const assistantMsg = page.getByTestId("message-assistant");
    await expect(assistantMsg).toBeVisible({ timeout: 15_000 });
    await expect(assistantMsg).toContainText("Here is the answer", { timeout: 15_000 });
  });

  test("creates a new conversation in the sidebar", async ({ page }) => {
    await page.goto("/chat");
    // Wait for the sidebar to finish loading conversations asynchronously
    await page.waitForLoadState("networkidle");

    const beforeCount = await page.getByTestId("conversation-item").count();

    await page.getByPlaceholder("Type a message...").fill("Hello LLM");
    await page.keyboard.press("Enter");

    // Wait for the assistant reply so we know the chat completed
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 15_000 });

    // A new conversation item should appear in the sidebar
    await expect(page.getByTestId("conversation-item")).toHaveCount(beforeCount + 1, { timeout: 10_000 });
  });

  test("auto-generates a conversation title after the first message", async ({ page }) => {
    await page.goto("/chat");

    await page.getByPlaceholder("Type a message...").fill("Tell me about Ghostbusters");
    await page.keyboard.press("Enter");

    // Wait for the response to complete
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 15_000 });

    // The sidebar item should update from "New Chat" to a generated title.
    // Our mock LLM returns "E2E Test Title" for non-streaming (title gen) requests.
    const convItem = page.getByTestId("conversation-item").first();
    await expect(convItem).not.toContainText("New Chat", { timeout: 10_000 });
  });
});

test.describe("Conversation history", () => {
  test("clicking a sidebar conversation loads its messages", async ({ page }) => {
    await page.goto("/chat");

    // Create a conversation
    await page.getByPlaceholder("Type a message...").fill("First message");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 15_000 });

    // Start a new chat (clears the current view)
    await page.getByRole("button", { name: /new chat/i }).click();
    await expect(page.getByTestId("message-user")).not.toBeVisible({ timeout: 5_000 });

    // Click the conversation in the sidebar to reload it
    await page.getByTestId("conversation-item").first().click();

    // Previous messages reload
    await expect(page.getByTestId("message-user")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 10_000 });
  });
});

test.describe("Deleting a conversation", () => {
  test("hovering a conversation reveals the delete button", async ({ page }) => {
    await page.goto("/chat");

    // Create a conversation first
    await page.getByPlaceholder("Type a message...").fill("Delete me");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 15_000 });

    // Hover the sidebar item to reveal the trash icon
    const convItem = page.getByTestId("conversation-item").first();
    await convItem.hover();

    // The Trash2 icon button should become visible
    await expect(convItem.locator("button")).toBeVisible();
  });

  test("clicking delete removes the conversation from the sidebar", async ({ page }) => {
    await page.goto("/chat");

    // Create a conversation
    await page.getByPlaceholder("Type a message...").fill("Please delete this");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-assistant")).toContainText("Here", { timeout: 15_000 });

    const countBefore = await page.getByTestId("conversation-item").count();
    expect(countBefore).toBeGreaterThan(0);

    // Hover and delete
    const convItem = page.getByTestId("conversation-item").first();
    await convItem.hover();
    await convItem.locator("button").click();

    // Item count should decrease
    await expect(page.getByTestId("conversation-item")).toHaveCount(countBefore - 1, {
      timeout: 5_000,
    });
  });
});

test.describe("New Chat button", () => {
  test("clicking New Chat clears the current conversation", async ({ page }) => {
    await page.goto("/chat");

    await page.getByPlaceholder("Type a message...").fill("Something");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-user")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /new chat/i }).click();

    // No messages visible in the main area
    await expect(page.getByTestId("message-user")).not.toBeVisible();
    await expect(page.getByTestId("message-assistant")).not.toBeVisible();
  });
});
