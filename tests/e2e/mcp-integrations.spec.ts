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
  const audience = await page.getByLabel("Delegation audience", { exact: true }).inputValue();
  expect(audience).toMatch(/^[a-f0-9-]{36}$/);
  const discovery = await fetch(`${BASE_URL}/api/mcp/info`);
  expect(discovery.ok).toBe(true);
  expect(await discovery.json()).toEqual({ version: 1, audience });
  await expect(page.getByText(/Public instance identifier, available before issuing credentials/)).toBeVisible();
  await expect(page.getByText("Configure and enable each integration here. Access is restricted to its saved WhatsApp group; container changes and restarts are not required.")).toBeVisible();
  const integrationName = `E2E integration ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("New integration name").fill(integrationName);
  const detailLoaded = page.waitForResponse((response) => response.request().method() === "GET"
    && /^\/api\/settings\/mcp-integrations\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Create integration" }).click();
  expect((await detailLoaded).ok()).toBe(true);
  await expect(page.getByLabel("Integration name", { exact: true })).toHaveValue(integrationName);
  await expect(page.getByRole("button", { name: "Enable integration", exact: true })).toBeDisabled();
  await page.getByLabel("WhatsApp group ID", { exact: true }).fill("120300000000@g.us");
  await page.getByLabel("media_select", { exact: true }).check();
  await page.getByLabel("Public linking origin", { exact: true }).fill("https://thinkarr.example.com");
  await page.getByLabel("WhatsApp bot number", { exact: true }).fill("+15555550100");
  await page.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save integration", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Enable integration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable integration", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Disable integration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable integration", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Create setup code", exact: true }).click();
  const setupCode = page.getByLabel("Setup code (shown once)", { exact: true });
  await expect(setupCode).toHaveValue(/^thk_setup_/);
  await page.getByRole("button", { name: "Dismiss setup code", exact: true }).click();
  await expect(setupCode).toHaveCount(0);

  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  const secret = page.getByLabel("New credential (shown once)", { exact: true });
  await expect(secret).toBeVisible();
  const firstToken = await secret.inputValue();
  expect(firstToken.startsWith("thk_svc_")).toBe(true);
  await expect(page.getByLabel("Delegation audience", { exact: true })).toHaveValue(audience);
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  await expect(secret).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: integrationName, exact: true }).click();
  await expect(page.getByLabel("media_select", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Public linking origin", { exact: true })).toHaveValue("https://thinkarr.example.com");
  await expect(page.getByLabel("WhatsApp bot number", { exact: true })).toHaveValue("15555550100");
  await expect(page.getByLabel("WhatsApp group ID", { exact: true })).toHaveValue("120300000000@g.us");
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
  await expect(page.getByRole("button", { name: "Enable integration", exact: true })).toBeEnabled();
});

test("a real non-admin session has personal MCP settings but no integration UI or management access", async ({ browser }) => {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { configDir: string };
  const sqlite = new Database(path.join(state.configDir, "thinkarr.db"));
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const linkedName = `Assistant link ${randomUUID().slice(0, 8)}`;
  try {
    const plexId = randomUUID();
    const id = sqlite.prepare("INSERT INTO users(plex_id, plex_username, is_admin, created_at) VALUES (?, ?, 0, ?)").run(plexId, "e2e-member", now).lastInsertRowid;
    sqlite.prepare("INSERT INTO sessions(id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sessionId, id, now + 3600, now);
    const principalId = randomUUID();
    sqlite.prepare("INSERT INTO mcp_service_principals(id, name, allowed_operations, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)").run(principalId, linkedName, now, now);
    sqlite.prepare("INSERT INTO mcp_actor_bindings(id, principal_id, actor_hash, context_hash, channel, context_kind, user_id, plex_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'whatsapp', 'group', ?, ?, ?, ?)")
      .run(randomUUID(), principalId, "synthetic-actor", "synthetic-context", id, plexId, now * 1000, now * 1000);
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
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your group assistant links" })).toBeVisible();
    await page.getByRole("button", { name: `Unlink ${linkedName}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Unlink ${linkedName}`, exact: true })).toHaveText("Unlinked");
    await expect(page.getByRole("button", { name: `Unlink ${linkedName}`, exact: true })).toBeDisabled();
    expect((await (await context.request.get(`${BASE_URL}/api/account-links`)).json()).data[0].revokedAt).not.toBeNull();
  } finally { await context.close(); }
});
