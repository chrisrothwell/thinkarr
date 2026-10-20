import { test, expect } from "@playwright/test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BASE_URL, STATE_FILE } from "./global-setup";

test("administrator manages scoped integrations, one-time secrets and public verification keys", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Service integrations" })).toBeVisible();
  await expect(page.getByText("Integrations can be prepared, but delegated tool access is not enabled in this build.")).toBeVisible();
  const integrationName = `E2E integration ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("New integration name").fill(integrationName);
  await page.getByRole("button", { name: "Create integration" }).click();
  await expect(page.getByLabel("Integration name", { exact: true })).toHaveValue(integrationName);
  await page.getByLabel("media_select", { exact: true }).check();
  await page.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save integration", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  const secret = page.getByLabel("New credential (shown once)", { exact: true });
  await expect(secret).toBeVisible();
  const firstToken = await secret.inputValue();
  expect(firstToken.startsWith("thk_svc_")).toBe(true);
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  await expect(secret).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: integrationName, exact: true }).click();
  await expect(page.getByLabel("media_select", { exact: true })).toBeChecked();
  await expect(secret).toHaveCount(0);
  expect(await page.locator("input, textarea").evaluateAll((nodes, token) => nodes.some((node) => (node as HTMLInputElement).value === token), firstToken)).toBe(false);
  await page.getByRole("button", { name: /^Rotate credential/ }).click();
  await expect(secret).toBeVisible();
  expect(await secret.inputValue()).not.toBe(firstToken);
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  const credentials = page.getByRole("table", { name: "Integration credentials" });
  await expect(credentials.getByRole("cell", { name: "Revoked", exact: true })).toHaveCount(1);
  const active = credentials.getByRole("row").filter({ has: page.getByRole("cell", { name: "Active", exact: true }) });
  await active.getByRole("button", { name: /^Revoke credential/ }).click();
  await expect(credentials.getByRole("cell", { name: "Revoked", exact: true })).toHaveCount(2);

  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await page.getByLabel("Connector issuer", { exact: true }).fill("connector:e2e");
  await page.getByLabel("Key ID", { exact: true }).fill("key-1");
  await page.getByLabel("Ed25519 public key (PEM)", { exact: true }).fill(publicKey);
  await page.getByRole("button", { name: "Register public key" }).click();
  await expect(page.getByRole("button", { name: "Revoke key key-1" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke key key-1" }).click();
  await expect(page.getByText("connector:e2e / key-1 — Revoked", { exact: true })).toBeVisible();
  await expect(page.getByText(/key_registered/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable integration", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable integration", exact: true })).toHaveCount(0);
});

test("a real non-admin session has personal MCP settings but no integration UI or management access", async ({ browser }) => {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { configDir: string };
  const sqlite = new Database(path.join(state.configDir, "thinkarr.db"));
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    const id = sqlite.prepare("INSERT INTO users(plex_id, plex_username, is_admin, created_at) VALUES (?, ?, 0, ?)").run(randomUUID(), "e2e-member", now).lastInsertRowid;
    sqlite.prepare("INSERT INTO sessions(id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sessionId, id, now + 3600, now);
  } finally { sqlite.close(); }
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await context.addCookies([{ name: "thinkarr_session", value: sessionId, url: BASE_URL }]);
    const page = await context.newPage();
    await page.goto("/settings");
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(page.getByLabel("Your Bearer Token", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Service integrations" })).toHaveCount(0);
    const response = await context.request.get(`${BASE_URL}/api/settings/mcp-integrations`);
    expect(response.status()).toBe(403);
  } finally { await context.close(); }
});
