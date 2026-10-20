import { test, expect, type BrowserContext } from "@playwright/test";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ADMIN_AUTH_FILE, BASE_URL, STATE_FILE } from "./global-setup";
import { privateAccountLinkUrl } from "../../src/lib/mcp/link-handoff";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const botNumber = "15555550100";
function database<T>(action: (db: Database.Database) => T): T {
  const { configDir } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { configDir: string };
  const db = new Database(path.join(configDir, "thinkarr.db"));
  db.pragma("foreign_keys = ON");
  try { return action(db); } finally { db.close(); }
}
function challenge() {
  const principalId = randomUUID(); const id = randomUUID(); const credentialId = randomUUID(); const keyId = randomUUID();
  const token = randomBytes(32).toString("hex"); const name = `Mobile assistant ${id.slice(0, 8)}`;
  const now = Date.now();
  database((db) => {
    // Isolated test fixture only: the production activation/transport gate is unchanged.
    db.prepare("INSERT INTO mcp_service_principals(id,name,enabled,allowed_operations,public_link_origin,whatsapp_bot_number,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?)")
      .run(principalId, name, JSON.stringify(["account_link_start", "account_link_confirm"]), BASE_URL, botNumber, Math.floor(now / 1000), Math.floor(now / 1000));
    db.prepare("INSERT INTO mcp_service_credentials(id,principal_id,token_hash,prefix,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(credentialId, principalId, hash(randomUUID()), "fixture", Math.floor(now / 1000), Math.floor(now / 1000) + 3600);
    db.prepare("INSERT INTO mcp_service_keys(id,principal_id,issuer,key_id,public_key_pem,created_at) VALUES (?,?,?,?,?,?)")
      .run(keyId, principalId, "connector:e2e", "mobile-key", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), Math.floor(now / 1000));
    db.prepare("INSERT INTO mcp_link_challenges(id,principal_id,credential_id,verification_key_id,token_hash,actor_hash,context_hash,handoff_config_hash,channel,context_kind,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?, 'whatsapp','group',?,?)")
      .run(id, principalId, credentialId, keyId, hash(token), hash("fixture actor"), hash("fixture group"), hash(JSON.stringify([BASE_URL, botNumber])), now, now + 300_000);
  });
  return { id, principalId, token, name, url: privateAccountLinkUrl(BASE_URL, token) };
}
async function signedIn(context: BrowserContext) {
  const state = JSON.parse(readFileSync(ADMIN_AUTH_FILE, "utf8"));
  await context.addCookies(state.cookies);
}

test("mobile private link signs into Plex and opens only the configured prefilled private message", async ({ page, context }) => {
  const link = challenge(); const networkUrls: string[] = [];
  page.on("request", (request) => networkUrls.push(request.url()));
  await context.route("https://app.plex.tv/**", (route) => route.fulfill({ contentType: "text/html", body: "Mock Plex sign-in" }));
  let handoff = ""; let referer: string | undefined;
  await page.route("https://wa.me/**", async (route) => {
    handoff = route.request().url(); referer = (await route.request().allHeaders()).referer;
    await route.fulfill({ contentType: "text/html", body: "WhatsApp handoff received" });
  });
  const response = await page.goto(link.url);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page).toHaveURL(`${BASE_URL}/mcp/connect`);
  await expect(page.getByText(`Connect to ${link.name} from WhatsApp.`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Plex", exact: true }).click();
  await expect(page.getByText("Signed in as", { exact: false })).toContainText("e2eadmin");
  await page.getByRole("button", { name: "Finish in WhatsApp", exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/wa\.me\/15555550100\?text=/);
  const destination = new URL(handoff);
  expect(destination.searchParams.get("text")).toMatch(/^Link account [a-f0-9]{64}$/);
  expect(destination.searchParams.size).toBe(1);
  expect(referer).toBeUndefined();
  expect(networkUrls.some((url) => url.includes(link.token))).toBe(false);
  database((db) => {
    const row = db.prepare("SELECT browser_user_id,completion_code_hash,consumed_at FROM mcp_link_challenges WHERE id=?").get(link.id) as { browser_user_id: number; completion_code_hash: string; consumed_at: number | null };
    expect(row.browser_user_id).toBe(1);
    expect(row.completion_code_hash).toBe(hash(destination.searchParams.get("text")!.replace("Link account ", "")));
    expect(row.consumed_at).toBeNull();
    expect((db.prepare("SELECT count(*) AS count FROM mcp_actor_bindings WHERE principal_id=?").get(link.principalId) as { count: number }).count).toBe(0);
  });
});

test("a new private fragment in the same tab replaces the old view and clears the URL again", async ({ page, context }) => {
  await signedIn(context);
  const first = challenge(); const second = challenge();
  await page.goto(first.url);
  await expect(page.getByText(`Connect to ${first.name} from WhatsApp.`, { exact: true })).toBeVisible();
  await page.evaluate((url) => { window.location.href = url; }, second.url);
  await expect(page.getByText(`Connect to ${second.name} from WhatsApp.`, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${BASE_URL}/mcp/connect`);
});

test("missing and expired private links show a safe recovery message without handoff", async ({ page, context }) => {
  await page.clock.install();
  await page.goto("/mcp/connect");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("expired or is no longer valid");
  await expect(page.getByRole("button", { name: "Sign in with Plex", exact: true })).toHaveCount(0);
  await signedIn(context);
  const link = challenge();
  await page.goto(link.url);
  await expect(page.getByRole("button", { name: "Finish in WhatsApp", exact: true })).toBeVisible();
  await page.clock.fastForward(301_000);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("expired or is no longer valid");
  await expect(page.getByRole("button", { name: "Finish in WhatsApp", exact: true })).toHaveCount(0);
});

test("changing the configured bot while a page is open cannot redirect a pending verification", async ({ page, context }) => {
  await signedIn(context); const link = challenge();
  await page.goto(link.url);
  await expect(page.getByRole("button", { name: "Finish in WhatsApp", exact: true })).toBeVisible();
  database((db) => db.prepare("UPDATE mcp_service_principals SET whatsapp_bot_number=? WHERE id=?").run("15555550101", link.principalId));
  await page.getByRole("button", { name: "Finish in WhatsApp", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("expired or is no longer valid");
  await expect(page).toHaveURL(`${BASE_URL}/mcp/connect`);
  expect(database((db) => (db.prepare("SELECT completion_code_hash FROM mcp_link_challenges WHERE id=?").get(link.id) as { completion_code_hash: string | null }).completion_code_hash)).toBeNull();
});

test("a changed browser sign-in cannot silently link a different Plex account than the one displayed", async ({ page, context }) => {
  await signedIn(context); const link = challenge();
  await page.goto(link.url);
  await expect(page.getByText("Signed in as", { exact: false })).toContainText("e2eadmin");
  const sessionId = randomUUID();
  database((db) => {
    const now = Math.floor(Date.now() / 1000);
    const userId = db.prepare("INSERT INTO users(plex_id,plex_username,is_admin,created_at) VALUES (?, 'other-account',0,?)").run(randomUUID(), now).lastInsertRowid;
    db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(sessionId, userId, now + 3600, now);
  });
  await context.addCookies([{ name: "thinkarr_session", value: sessionId, url: BASE_URL }]);
  await page.getByRole("button", { name: "Finish in WhatsApp", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("sign-in changed");
  await expect(page).toHaveURL(`${BASE_URL}/mcp/connect`);
  expect(database((db) => (db.prepare("SELECT completion_code_hash FROM mcp_link_challenges WHERE id=?").get(link.id) as { completion_code_hash: string | null }).completion_code_hash)).toBeNull();
});

test("a blocked Plex popup provides a normal link and keeps sign-in polling in the original tab", async ({ page, context }) => {
  const link = challenge(); let allowCallback = false;
  await page.addInitScript(() => { window.open = () => null; });
  await context.route("https://app.plex.tv/**", (route) => route.fulfill({ contentType: "text/html", body: "Mock Plex sign-in" }));
  await page.route("**/api/auth/callback", async (route) => {
    if (!allowCallback) await route.fulfill({ json: { success: false, error: "pending" } });
    else await route.continue();
  });
  await page.goto(link.url);
  await page.getByRole("button", { name: "Sign in with Plex", exact: true }).click();
  const fallback = page.getByRole("link", { name: "Open Plex sign-in", exact: true });
  await expect(fallback).toBeVisible();
  expect(new URL((await fallback.getAttribute("href"))!).origin).toBe("https://app.plex.tv");
  allowCallback = true;
  await fallback.click();
  await expect(page.getByRole("button", { name: "Finish in WhatsApp", exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${BASE_URL}/mcp/connect`);
});
