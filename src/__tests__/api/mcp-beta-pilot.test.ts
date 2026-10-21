import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";
import { register } from "../../../connectors/openclaw/index";
import type { DispatchContext, DispatchEvent, DispatchResult, OpenClawHost, Outbound } from "../../../connectors/openclaw/host";

let db: TestDb; let sqlite: Database.Database; let directory: string; let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ getOpenAITools: vi.fn(() => []), hasTools: () => true, executeTool: vi.fn() }));
import { POST, GET } from "@/app/api/mcp/route";
import { getDelegationAudience } from "@/lib/mcp/delegation";
import { completeAccountLink, initiateAccountLink, prepareAccountLink, revokeAccountBinding } from "@/lib/mcp/account-linking";
import { SERVICE_OPERATIONS, updateIntegration } from "@/lib/mcp/service-principals";
import { setConfig } from "@/lib/config";
import { executeTool } from "@/lib/tools/registry";

const group = "120300000000@g.us"; const sender = "+15555550101"; const canonical = "15555550101@s.whatsapp.net";
beforeEach(async () => {
  ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true });
  directory = await mkdtemp(join(tmpdir(), "thinkarr-beta-pilot-"));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-21T14:00:00Z")); vi.clearAllMocks();
  vi.stubEnv("PLEX_API_BASE", "https://plex.invalid");
  setConfig("overseerr.url", "https://seerr.invalid"); setConfig("overseerr.apiKey", "SECRET-directory-key");
});
afterEach(async () => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function fixture(link = true) {
  const f = await delegatedLinkFixture(db, adminId);
  vi.stubEnv("THINKARR_MCP_PILOT_PRINCIPAL", f.principal.id); vi.stubEnv("THINKARR_MCP_PILOT_GROUP", group);
  updateIntegration(f.principal.id, { allowedOperations: [...SERVICE_OPERATIONS], enabled: true }, adminId);
  db.update(schema.users).set({ plexId: "101", plexToken: "SECRET-actor-token" }).where(eq(schema.users.id, f.userA)).run();
  const credentialsFile = join(directory, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({ endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
    service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(), keyId: f.key.keyId,
    bearer: f.credential.token, privateKeyPem: f.privateKeyPem }), { mode: 0o600 });
  const state = { writes: [] as Array<{ body: Record<string, unknown>; headers: Headers }>, permissions: 32, missingUser: false,
    remaining: 5, resultStatus: 1, mediaStatus: 1, writeMode: "normal", failDelivery: false, wrongReceipt: false,
    afterMe: undefined as (() => void) | undefined };
  const catalog = (id: number, mediaType: "movie" | "tv") => ({ id, mediaType, title: `Movie ${id}`, name: `Show ${id}`,
    releaseDate: "2024-01-01", firstAirDate: "2024-01-01", overview: "A title synopsis.", voteAverage: 7.5,
    genres: [{ name: "Drama", email: "SECRET" }], credits: { cast: [{ name: "An Actor", profilePath: "SECRET" }] },
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }],
    mediaInfo: { status: state.mediaStatus, requests: [{ requestedBy: { email: "SECRET", displayName: "SECRET" } }] },
    posterPath: "SECRET", account: { token: "SECRET" } });
  const fetchRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    if (url.origin === "https://thinkarr.invalid") return POST(new Request(input, init));
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    if (url.origin === "https://plex.invalid" && url.pathname === "/api/v2/user") {
      expect(headers.get("X-Plex-Token")).toBe("SECRET-actor-token"); return Response.json({ id: 101 });
    }
    if (url.origin !== "https://seerr.invalid") throw new Error("Unpinned destination");
    expect(headers.get("X-Api-Key")).toBe("SECRET-directory-key");
    if (init?.method === "POST") {
      expect(url.pathname).toBe("/api/v1/request"); expect(headers.get("X-Api-User")).toBe("7");
      const body = JSON.parse(String(init.body)); state.writes.push({ body, headers });
      if (state.writeMode === "timeout") throw new Error("SECRET transport failure after submission");
      if (state.writeMode === "http") return new Response("SECRET upstream diagnostic", { status: 500 });
      state.mediaStatus = 2;
      return Response.json({ id: 900, type: body.mediaType, status: state.resultStatus,
        requestedBy: { id: state.writeMode === "attribution" ? 1 : 7, displayName: "SECRET" }, media: { tmdbId: body.mediaId },
        ...(body.seasons ? { seasons: (body.seasons as number[]).map((seasonNumber) => ({ seasonNumber })) } : {}) });
    }
    if (url.pathname === "/api/v1/search") return Response.json({ results: [catalog(123, "movie"), catalog(222, "tv"), { mediaType: "person", name: "SECRET" }] });
    if (/^\/api\/v1\/(movie|tv)\/\d+$/.test(url.pathname)) return Response.json(catalog(Number(url.pathname.split("/").at(-1)), url.pathname.includes("/tv/") ? "tv" : "movie"));
    if (url.pathname === "/api/v1/user") return Response.json({ pageInfo: { page: 1, pageSize: 100, pages: state.missingUser ? 0 : 1, results: state.missingUser ? 0 : 1 },
      results: state.missingUser ? [] : [{ id: 7, plexId: 101, userType: 1, email: "SECRET" }] });
    expect(headers.get("X-Api-User")).toBe("7");
    if (url.pathname === "/api/v1/auth/me") { state.afterMe?.(); return Response.json({ id: 7, plexId: 101, userType: 1, permissions: state.permissions }); }
    if (url.pathname === "/api/v1/user/7/quota") return Response.json({ movie: { used: 0, limit: 5, remaining: state.remaining, restricted: false }, tv: { used: 0, limit: 5, remaining: state.remaining, restricted: false } });
    throw new Error("Unexpected endpoint");
  });
  vi.stubGlobal("fetch", fetchRequest);
  const factories = new Map<string, Parameters<OpenClawHost<object>["registerTool"]>[0]>();
  let hook: ((event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | void>) | undefined;
  const sends: Array<{ text: string; to: string; messageId: string }> = [];
  const outbound: Outbound<object> = {
    resolveTarget: ({ to }) => ({ ok: true, to }),
    async sendText(params) {
      await params.onPlatformSendDispatch();
      const messageId = `out-${sends.length + 1}`; sends.push({ text: params.text, to: params.to, messageId });
      if (state.failDelivery) throw new Error("SECRET uncertain send");
      return { channel: "whatsapp", messageId, toJid: state.wrongReceipt ? "another-group@g.us" : params.to };
    },
  };
  const api: OpenClawHost<object> = { registrationMode: "full", config: {},
    pluginConfig: { credentialsFile, accounts: { "account-A": "+15555550100" }, pilotGroup: group }, lifecycle: { signal: new AbortController().signal },
    runtime: { version: "2026.10.4", channel: { outbound: { loadAdapter: async () => outbound } } },
    registerTool: (factory, options) => { for (const name of options.names) factories.set(name, factory); },
    on: (_name, handler) => { hook = handler; },
  };
  register(api);
  const tool = (name: string, args: unknown, conversation = group) => factories.get(name)!.create({ messageChannel: "whatsapp", agentAccountId: "account-A", requesterSenderId: sender, nativeChannelId: conversation, assertInvocationCurrent: () => {} })!.execute("call", args);
  const dispatch = (text: string, id = "confirmation", time = Date.now(), replyTo?: string) => hook!({ content: text, channel: "whatsapp", senderId: sender, messageId: id, timestamp: time, isGroup: true,
    ...(replyTo ? { replyToId: replyTo, replyToIsQuote: true } : {}) }, { channelId: "whatsapp", accountId: "account-A", conversationId: group, senderId: canonical, messageId: id,
    ...(replyTo ? { replyToId: replyTo, replyToIsQuote: true } : {}) });
  if (link) {
    expect((await tool("thinkarr_account_link", {})).details.status).toBe("private_link_sent");
    const url = sends[0].text.split(" ").at(-1)!;
    const code = prepareAccountLink(new URL(url).hash.slice(7), f.sessionA, f.userA).completionCode;
    expect(await hook!({ content: `Link account ${code}`, channel: "whatsapp", senderId: sender, messageId: "link-event", timestamp: Date.now(), isGroup: false },
      { channelId: "whatsapp", accountId: "account-A", conversationId: sender, senderId: canonical, messageId: "link-event" })).toEqual({ handled: true, text: "Your Plex account is linked." });
  }
  return { f, state, sends, fetchRequest, tool, dispatch, factories,
    select: (args: unknown = { id: 123, mediaType: "movie" }) => tool("thinkarr_media_select", args),
    raw: (name: string, args: Record<string, unknown> = {}, patch = {}) => f.signedRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { sender: canonical, conversation: group, ...patch }).then(POST),
  };
}

describe("minimal beta pilot: real plugin, signed SDK, SQLite, mocked Seerr", () => {
  it("links privately, searches safe existing catalog facts, presents a real prompt and submits only after native confirmation", async () => {
    const h = await fixture();
    const search = await h.tool("thinkarr_media_search", { query: "Movie" });
    expect(search.details).toMatchObject({ status: "ok", items: [{ id: 123, title: "Movie 123" }, { id: 222, title: "Show 222" }] });
    expect(JSON.stringify(search)).not.toMatch(/SECRET|poster|requests|account|mediaInfo|availability/);
    expect((await h.select()).details.status).toBe("prompt_sent");
    expect(h.sends.at(-1)).toMatchObject({ to: group, text: expect.stringContaining("Movie 123 (2024)") });
    expect(h.state.writes).toHaveLength(0);
    expect(await h.dispatch("request it")).toEqual({ handled: true, text: "Your request was submitted and is awaiting approval in Seerr." });
    expect(h.state.writes.map((w) => w.body)).toEqual([{ mediaType: "movie", mediaId: 123 }]);
    expect(h.state.writes[0].body).not.toHaveProperty("userId");
    expect(db.select().from(schema.mcpMediaSelections).get()).toMatchObject({ state: "completed", outcome: "pending_approval" });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("preserves Seerr automatic approval and submits only the explicit validated TV season subset", async () => {
    const h = await fixture(); h.state.resultStatus = 2;
    expect((await h.select({ id: 222, mediaType: "tv", seasons: [2] })).details.status).toBe("prompt_sent");
    expect(await h.dispatch("request 1")).toEqual({ handled: true, text: "Your request was submitted to Seerr." });
    expect(h.state.writes[0].body).toEqual({ mediaType: "tv", mediaId: 222, seasons: [2] });
  });

  it("uses the same discovery/direct-call allowlist and hides write authority from model tools", async () => {
    const h = await fixture();
    const listed = await POST(await h.f.signedRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { sender: canonical, conversation: group }));
    expect((await listed.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["account_link_start", "media_search", "media_details", "media_select"]);
    for (const [name, args] of [["media_confirm_request", {}], ["media_select", { selectionId: "123", promptMessageId: "invented" }], ["overseerr_request_movie", { id: 123 }], ["plex_get_on_deck", {}], ["overseerr_list_requests", {}], ["splitwise_add_expense", {}]] as const) expect((await h.raw(name, args)).status).toBe(403);
    expect((await GET(new Request("https://thinkarr.invalid/api/mcp", { headers: { Authorization: `Bearer ${h.f.credential.token}` } }))).status).toBe(403);
    expect(h.state.writes).toHaveLength(0); expect(executeTool).not.toHaveBeenCalled();
  });

  it("requires linking, the configured principal/group and the current pilot environment", async () => {
    const h = await fixture(false);
    expect((await h.tool("thinkarr_media_search", { query: "Movie" })).details.status).toBe("failed");
    expect((await h.raw("account_link_start", {}, { conversation: "another@g.us" })).status).toBe(403);
    vi.stubEnv("THINKARR_MCP_PILOT_GROUP", "");
    expect((await h.raw("account_link_start")).status).toBe(403);
    expect(() => updateIntegration(h.f.principal.id, { enabled: true }, adminId)).toThrow("not available");
  });

  it.each(["missingUser", "permission", "quota", "already-requested"])("fails closed on current %s without any downstream write", async (mode) => {
    const h = await fixture(); await h.select();
    if (mode === "missingUser") h.state.missingUser = true;
    if (mode === "permission") { h.state.permissions = 0; db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, h.f.userA)).run(); }
    if (mode === "quota") h.state.remaining = 0;
    if (mode === "already-requested") h.state.mediaStatus = 2;
    expect(await h.dispatch("request it")).toMatchObject({ handled: true, text: expect.stringContaining("could not be submitted") });
    expect(h.state.writes).toHaveLength(0);
  });

  it.each(["timeout", "http", "attribution"])("retains an uncertain %s and does not retry even after a fresh selection", async (mode) => {
    const h = await fixture(); h.state.writeMode = mode; await h.select();
    expect(await h.dispatch("request it")).toMatchObject({ handled: true, text: expect.stringContaining("could not verify") });
    expect(db.select().from(schema.mcpMediaSelections).get()!.state).toBe("unknown");
    h.state.writeMode = "normal"; await h.select();
    expect(await h.dispatch("request it", "retry", Date.now(), h.sends.at(-1)!.messageId)).toMatchObject({ text: expect.stringContaining("could not verify") });
    expect(h.state.writes).toHaveLength(1);
  });

  it.each(["failDelivery", "wrongReceipt"])("does not activate an unverified presentation: %s", async (mode) => {
    const h = await fixture(); h.state[mode as "failDelivery" | "wrongReceipt"] = true;
    expect((await h.select()).details.status).toBe("failed");
    expect(db.select().from(schema.mcpMediaSelections).get()!.state).toBe("draft");
    expect(await h.dispatch("request it")).toBeUndefined(); expect(h.state.writes).toHaveLength(0);
  });

  it("does not seize finance messages, bare assent or a yes quoting an unrelated message", async () => {
    const h = await fixture(); await h.select();
    for (const text of ["yes", "yes please", "2", "split dinner three ways", "do not request it", "request it if free"]) expect(await h.dispatch(text)).toBeUndefined();
    expect(await h.dispatch("yes", "finance", Date.now(), "splitwise-message")).toBeUndefined();
    expect(h.state.writes).toHaveLength(0);
    expect(await h.dispatch("yes please", "quoted-media", Date.now(), h.sends.at(-1)!.messageId)).toMatchObject({ handled: true, text: expect.stringContaining("awaiting approval") });
  });

  it("expires after two minutes and lets a new choice replace the old prompt immediately", async () => {
    const h = await fixture(); await h.select();
    vi.setSystemTime(Date.now() + 120_000);
    expect(await h.dispatch("request it")).toMatchObject({ text: expect.stringContaining("expired") });
    expect((await h.select({ id: 456, mediaType: "movie" })).details.status).toBe("prompt_sent");
    expect(await h.dispatch("request it", "fresh")).toMatchObject({ text: expect.stringContaining("awaiting approval") });
    expect(h.state.writes[0].body.mediaId).toBe(456);
  });

  it("rejects old/queued replies after replacement and requires a quote for the new choice", async () => {
    const h = await fixture(); await h.select(); const old = h.sends.at(-1)!.messageId;
    vi.setSystemTime(Date.now() + 10);
    await h.select({ id: 456, mediaType: "movie" }); const fresh = h.sends.at(-1)!.messageId;
    for (const [event, time, replyTo] of [["unquoted", Date.now(), undefined], ["old-quote", Date.now(), old], ["queued", Date.now() - 1, fresh]] as const) {
      expect(await h.dispatch("request it", event, time, replyTo)).toMatchObject({ text: expect.stringContaining("reply directly") });
    }
    expect(h.state.writes).toHaveLength(0);
    expect(await h.dispatch("request it", "new", Date.now(), fresh)).toMatchObject({ text: expect.stringContaining("awaiting approval") });
    expect(h.state.writes[0].body.mediaId).toBe(456);
  });

  it("claims concurrent confirmations once and ignores duplicate provider delivery", async () => {
    const h = await fixture(); await h.select();
    await Promise.all([h.dispatch("request it", "a"), h.dispatch("request it", "b")]);
    expect(h.state.writes).toHaveLength(1);
    expect(await h.dispatch("request it", "a")).toBeUndefined();
    expect(h.state.writes).toHaveLength(1);
  });

  it("does not let a separately linked participant present or confirm another person's selection", async () => {
    const h = await fixture(); await h.select();
    const other = "15555550102@s.whatsapp.net";
    const started = initiateAccountLink(await h.f.context({ sender: other, conversation: group }));
    if (started.linked) throw new Error("Unexpected fixture binding");
    const code = prepareAccountLink(started.token, h.f.sessionB, h.f.userB).completionCode;
    completeAccountLink(await h.f.privateContext(code, { sender: other }), code);
    const row = db.select().from(schema.mcpMediaSelections).get()!;
    const presented = await h.raw("media_select", { selectionId: row.id, promptMessageId: "forged" }, { sender: other, source: "command", intent: `present:${row.id}` });
    expect(JSON.parse((await presented.json()).result.content[0].text)).toEqual({ status: "failed" });
    const confirmation = await h.raw("media_confirm_request", {}, { sender: other, source: "message", intent: "confirm-current", eventId: "other-event", eventTime: Date.now() });
    expect(JSON.parse((await confirmation.json()).result.content[0].text)).toEqual({ status: "unclaimed" });
    expect(db.select().from(schema.mcpMediaSelections).get()!.state).toBe("pending");
    expect(h.state.writes).toHaveLength(0);
  });

  it("rejects a consumed provider event against a fresh prompt even with fresh HTTP assertions", async () => {
    const h = await fixture(); await h.select(); h.state.permissions = 0;
    await h.dispatch("request it", "consumed");
    h.state.permissions = 32; await h.select();
    expect(await h.dispatch("request it", "consumed")).toMatchObject({ text: expect.stringContaining("could not be completed") });
    expect(h.state.writes).toHaveLength(0);
    expect(await h.dispatch("request it", "fresh-event")).toMatchObject({ text: expect.stringContaining("awaiting approval") });
    expect(h.state.writes).toHaveLength(1);
  });

  it("rechecks binding revocation immediately before submission and rejects invented seasons/identity fields", async () => {
    const h = await fixture();
    for (const args of [{ id: 222, mediaType: "tv", seasons: [99] }, { id: 222, mediaType: "tv", seasons: [1, 1] }, { id: 123, mediaType: "movie", userId: 1 }]) expect((await h.select(args)).details.status).not.toBe("prompt_sent");
    await h.select();
    h.state.afterMe = () => revokeAccountBinding(db.select().from(schema.mcpActorBindings).get()!.id, h.f.userA);
    expect(await h.dispatch("request it")).toMatchObject({ text: expect.stringContaining("could not be completed") });
    expect(h.state.writes).toHaveLength(0);
  });
});
