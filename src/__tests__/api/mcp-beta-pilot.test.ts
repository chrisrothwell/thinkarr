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
import type { DispatchContext, DispatchEvent, DispatchResult, GroupReplyContext, GroupReplyEvent, GroupReplyResult, OpenClawHost, Outbound, ToolHookContext, ToolHookEvent, ReplyPayloadEvent, MessageHookContext } from "../../../connectors/openclaw/host";

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

async function fixture(link = true, debug = false) {
  const f = await delegatedLinkFixture(db, adminId);
  updateIntegration(f.principal.id, { allowedOperations: [...SERVICE_OPERATIONS], pilotGroup: group, enabled: true }, adminId);
  db.update(schema.users).set({ plexId: "101", plexToken: "SECRET-actor-token" }).where(eq(schema.users.id, f.userA)).run();
  const credentialsFile = join(directory, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({ endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
    service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(), keyId: f.key.keyId,
    bearer: f.credential.token, privateKeyPem: f.privateKeyPem }), { mode: 0o600 });
  const state = { writes: [] as Array<{ body: Record<string, unknown>; headers: Headers }>, permissions: 32, missingUser: false,
    remaining: 5, resultStatus: 1, mediaStatus: 1, writeMode: "normal", failDelivery: false, wrongReceipt: false,
    afterMe: undefined as (() => void) | undefined, afterWrite: undefined as (() => void) | undefined, loseConfirmationResponse: false };
  const catalog = (id: number, mediaType: "movie" | "tv") => ({ id, mediaType, title: `Movie ${id}`, name: `Show ${id}`,
    releaseDate: "2024-01-01", firstAirDate: "2024-01-01", overview: "A title synopsis.", voteAverage: 7.5,
    genres: [{ name: "Drama", email: "SECRET" }], credits: { cast: [{ name: "An Actor", profilePath: "SECRET" }] },
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }],
    mediaInfo: { status: state.mediaStatus, requests: [{ requestedBy: { email: "SECRET", displayName: "SECRET" } }] },
    posterPath: "SECRET", account: { token: "SECRET" } });
  const fetchRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    if (url.origin === "https://thinkarr.invalid") {
      const response = await POST(new Request(input, init));
      const request = JSON.parse(String(init?.body));
      if (state.loseConfirmationResponse && request.method === "tools/call" && request.params?.name === "media_confirm_request") throw new DOMException("SECRET lost response after commit", "TimeoutError");
      return response;
    }
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
      state.afterWrite?.();
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
  const logLines: string[] = [];
  const logger = { info: (line: string) => { logLines.push(line); }, warn: (line: string) => { logLines.push(line); }, error: (line: string) => { logLines.push(line); } };
  let hook: ((event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | void>) | undefined;
  let groupHook: ((event: GroupReplyEvent, ctx: GroupReplyContext<object>) => Promise<GroupReplyResult | void>) | undefined;
  let toolGuard: ((event: ToolHookEvent, ctx: ToolHookContext) => Promise<{ block?: boolean } | void>) | undefined;
  let replyGuard: ((event: ReplyPayloadEvent, ctx: MessageHookContext) => Promise<{ cancel?: boolean } | void>) | undefined;
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
  const api: OpenClawHost<object> = { registrationMode: "full", config: {}, logger,
    pluginConfig: { credentialsFile, accounts: { "account-A": "+15555550100" }, pilotGroup: group, debug }, lifecycle: { signal: new AbortController().signal },
    runtime: { version: "2026.10.4", channel: { outbound: { loadAdapter: async () => outbound } } },
    registerTool: (factory, options) => { for (const name of options.names) factories.set(name, factory); },
    on: (name, handler) => {
      if (name === "before_dispatch") hook = handler as NonNullable<typeof hook>;
      else if (name === "reply_dispatch") groupHook = handler as NonNullable<typeof groupHook>;
      else if (name === "before_tool_call") toolGuard = handler as NonNullable<typeof toolGuard>;
      else if (name === "reply_payload_sending") replyGuard = handler as NonNullable<typeof replyGuard>;
    },
  };
  register(api);
  const tool = (name: string, args: unknown, conversation = group) => factories.get(name)!.create({ sessionKey: "session-pilot", messageChannel: "whatsapp", agentAccountId: "account-A", requesterSenderId: sender, nativeChannelId: conversation, assertInvocationCurrent: () => {} })!.execute("call", args);
  const nativeEvent = (text: string, id = "confirmation", time = Date.now(), replyTo?: string): GroupReplyEvent => ({
    ctx: { RawBody: text, Provider: "whatsapp", Surface: "whatsapp", OriginatingChannel: "whatsapp", AccountId: "account-A",
      From: group, ChatId: group, OriginatingTo: group, To: "+15555550100", ChatType: "group", SenderId: canonical,
      MessageSid: id, Timestamp: time, InboundAccessAuthorized: true, InboundEventKind: "user_request",
      ...(replyTo ? { ReplyToId: replyTo, SupplementalContext: { quote: { id: replyTo } } } : {}),
    }, sendPolicy: "allow", sourceReplyDeliveryMode: "message_tool_only", suppressUserDelivery: true,
    originatingChannel: "whatsapp", originatingTo: group, originatingAccountId: "account-A", originatingChatType: "group",
  });
  const recordProcessed = vi.fn(); const markIdle = vi.fn();
  const dispatchNative = (event: GroupReplyEvent, context: Partial<GroupReplyContext<object>> = {}) => groupHook!(event, { cfg: {}, dispatchKind: "agent", recordProcessed, markIdle, ...context });
  const dispatch = async (text: string, id = "confirmation", time = Date.now(), replyTo?: string) => {
    const before = sends.length; const result = await dispatchNative(nativeEvent(text, id, time, replyTo));
    // Existing user-facing assertions now inspect real, receipt-checked outbound
    // status text rather than automatic text returned by a mocked legacy hook.
    return result ? { handled: result.handled, ...(result.queuedFinal && sends.length > before ? { text: sends.at(-1)!.text } : {}) } : undefined;
  };
  if (link) {
    expect((await tool("thinkarr_account_link", {})).details.status).toBe("private_link_sent");
    const url = sends[0].text.split(" ").at(-1)!;
    const code = prepareAccountLink(new URL(url).hash.slice(7), f.sessionA, f.userA).completionCode;
    expect(await hook!({ content: `Link account ${code}`, channel: "whatsapp", senderId: sender, messageId: "link-event", timestamp: Date.now(), isGroup: false },
      { channelId: "whatsapp", accountId: "account-A", conversationId: "+15555550100", senderId: canonical, messageId: "link-event" })).toEqual({ handled: true });
    expect(sends.at(-1)).toMatchObject({ to: canonical, text: "Your Plex account is linked." });
  }
  return { f, state, sends, fetchRequest, tool, dispatch, dispatchNative, nativeEvent, recordProcessed, markIdle, factories,
    // Pinned tool hooks carry currentChannelId: the native group, NOT provider.
    beforeTool: (name: string, params: Record<string, unknown>, runId = "run-pilot", toolKind?: "code_mode_exec", channelId: string | undefined = group) => toolGuard!({ toolName: name, params, toolKind }, { toolName: name, toolCallId: "call", sessionKey: "session-pilot", channelId, runId, toolKind }),
    guardReply: (event: ReplyPayloadEvent, ctx: MessageHookContext) => replyGuard!(event, ctx),
    logs: () => logLines.map((line) => JSON.parse(line.slice("[thinkarr] ".length))),
    select: (args: unknown = { id: 123, mediaType: "movie" }) => tool("thinkarr_media_select", args),
    raw: (name: string, args: Record<string, unknown> = {}, patch = {}) => f.signedRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { sender: canonical, conversation: group, ...patch }).then(POST),
  };
}

describe("minimal beta pilot: real plugin, signed SDK, SQLite, mocked Seerr", () => {
  it("keeps admitted media descriptors eligible for the host Code Mode catalog without bypassing actor admission", async () => {
    const h = await fixture();
    for (const name of ["thinkarr_media_search", "thinkarr_media_details", "thinkarr_media_select"]) {
      const create = h.factories.get(name)!.create;
      const admitted = create({ sessionKey: "session-pilot", messageChannel: "whatsapp", agentAccountId: "account-A", requesterSenderId: sender, nativeChannelId: group, assertInvocationCurrent: () => {} });
      // The pinned host excludes direct-only descriptors from Code Mode globals
      // and catalog.search. Descriptor eligibility is part of the adapter contract.
      expect(admitted?.name).toBe(name); expect(admitted?.catalogMode).not.toBe("direct-only");
      expect(create({ sessionKey: "session-pilot", assertInvocationCurrent: () => {} })).toBeNull();
    }
  });
  it("guards a real native selection through host-discriminated Code Mode wrappers, while shell/finance work stays unmuted", async () => {
    const h = await fixture();
    await h.beforeTool("exec", { code: "native media workflow" }, "run-pilot", "code_mode_exec");
    await h.beforeTool("thinkarr_media_select", {});
    expect((await h.select()).details.status).toBe("prompt_sent");
    await h.beforeTool("exec", { code: "nested message workflow" }, "run-pilot", "code_mode_exec");
    const duplicate = { action: "send", target: group, channel: "whatsapp", message: "Follow the confirmation prompt." };
    expect(await h.beforeTool("message", duplicate)).toMatchObject({ block: true });
    await h.beforeTool("splitwise_get_balances", {});
    expect(await h.beforeTool("message", duplicate)).toBeUndefined();
    await h.beforeTool("thinkarr_media_select", {}, "shell-run"); await h.select();
    await h.beforeTool("exec", { command: "shell workflow" }, "shell-run");
    expect(await h.beforeTool("message", duplicate, "shell-run")).toBeUndefined();
    expect(h.state.writes).toHaveLength(0);
  });
  it("cancels the redundant automatic reply after the live-shaped Code Mode media reads and native prompt, then submits once", async () => {
    const h = await fixture(true, true); const before = h.sends.length;
    await h.beforeTool("exec", { code: "media lookup" }, "run-pilot", "code_mode_exec");
    await h.beforeTool("mcp_thinkarr_plex_check_availability", {});
    await h.beforeTool("exec", { code: "catalog lookup" }, "run-pilot", "code_mode_exec");
    await h.beforeTool("mcp_thinkarr_overseerr_search", { query: "Movie" });
    await h.beforeTool("exec", { code: "native selection" }, "run-pilot", "code_mode_exec");
    await h.beforeTool("thinkarr_media_select", {});
    expect((await h.select()).details.status).toBe("prompt_sent");
    expect(h.sends).toHaveLength(before + 1); const prompt = h.sends.at(-1)!;
    expect(h.logs().some((r) => r.stage === "presentation.guard_armed")).toBe(true);
    const event: ReplyPayloadEvent = { runId: "run-pilot", sessionKey: "session-pilot", channel: "whatsapp", kind: "final", payload: { text: "Follow the confirmation prompt." } };
    // Pinned reply hooks use provider channelId and may expose receiving bot To
    // as conversationId, rather than the native group used by tool hooks.
    const ctx: MessageHookContext = { channelId: "whatsapp", accountId: "account-A", conversationId: "+15555550100", sessionKey: "session-pilot" };
    expect(await h.guardReply(event, ctx)).toMatchObject({ cancel: true });
    expect(await h.guardReply(event, { ...ctx, conversationId: "15555550100@s.whatsapp.net" })).toMatchObject({ cancel: true });
    expect(h.sends).toHaveLength(before + 1);
    const native = h.nativeEvent("request it", "live-shaped-confirmation", Date.now(), prompt.messageId);
    expect(await h.dispatchNative({ ...native, ctx: { ...native.ctx, SupplementalContext: undefined } })).toMatchObject({ handled: true, queuedFinal: true });
    expect(h.sends).toHaveLength(before + 2); expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].headers.get("X-Api-User")).toBe("7"); expect(h.state.writes[0].body).not.toHaveProperty("userId");
  });
  it.each(["whatsapp", "120300000099@g.us", "", "+15555550100"])("does not arm presentation from a provider label or wrong/missing native group (%s)", async (channelId) => {
    const h = await fixture(true, true);
    await h.beforeTool("thinkarr_media_select", {}, "run-pilot", undefined, channelId);
    await h.select();
    expect(h.logs().some((r) => r.stage === "presentation.guard_armed")).toBe(false);
    expect(h.logs().find((r) => r.reason === "host_tool_conversation_mismatch")).toBeDefined();
    const event: ReplyPayloadEvent = { runId: "run-pilot", sessionKey: "session-pilot", channel: "whatsapp", kind: "final", payload: { text: "Normal reply" } };
    expect(await h.guardReply(event, { channelId: "whatsapp", accountId: "account-A", conversationId: group, sessionKey: "session-pilot" })).toBeUndefined();
  });
  it("accepts a channel-prefixed native tool group but never treats other peers/bots/turns as the receiving-bot reply route", async () => {
    const h = await fixture(); await h.beforeTool("thinkarr_media_select", {}, "run-pilot", undefined, `whatsapp:${group}`); await h.select();
    const event: ReplyPayloadEvent = { runId: "run-pilot", sessionKey: "session-pilot", channel: "whatsapp", kind: "final", payload: { text: "Duplicate reply" } };
    const ctx: MessageHookContext = { channelId: "whatsapp", accountId: "account-A", conversationId: "+15555550100", sessionKey: "session-pilot" };
    expect(await h.guardReply(event, ctx)).toMatchObject({ cancel: true });
    for (const conversationId of [sender, "+15555550200", "12345@lid", "120300000099@g.us", undefined]) {
      expect(await h.guardReply(event, { ...ctx, conversationId })).toBeUndefined();
    }
    expect(await h.guardReply(event, { ...ctx, accountId: "other" })).toBeUndefined();
    expect(await h.guardReply({ ...event, runId: "later-turn" }, ctx)).toBeUndefined();
    expect(await h.guardReply({ ...event, sessionKey: "other-session" }, ctx)).toBeUndefined();
  });
  it.each(["splitwise_get_balances", "mcp_thinkarr_plex_get_on_deck", "mcp_thinkarr_overseerr_report_issue", "overseerr_search_extra"])("preserves a mixed workflow containing %s", async (name) => {
    const h = await fixture(true, true); await h.beforeTool(name, {}); await h.beforeTool("thinkarr_media_select", {}); await h.select();
    const event: ReplyPayloadEvent = { runId: "run-pilot", sessionKey: "session-pilot", channel: "whatsapp", kind: "final", payload: { text: "A useful unrelated response" } };
    expect(await h.guardReply(event, { channelId: "whatsapp", accountId: "account-A", conversationId: group, sessionKey: "session-pilot" })).toBeUndefined();
    expect(h.logs().some((r) => r.stage === "presentation.guard_unavailable" && r.reason === "mixed_workflow")).toBe(true);
  });
  it("sends one self-contained prompt, then uses admitted native group facts despite a bot-address legacy conversation", async () => {
    const h = await fixture(true, true); const before = h.sends.length;
    const selected = await h.select();
    expect(selected.details.status).toBe("prompt_sent"); expect(selected.content[0].text).toContain("End this turn with NO_REPLY");
    expect(h.sends).toHaveLength(before + 1);
    const prompt = h.sends.at(-1)!;
    expect(prompt.text).toContain("Reply directly to this message with “request it” within two minutes");
    const result = await h.dispatchNative(h.nativeEvent("request it", "native-confirmation", Date.now(), prompt.messageId));
    expect(result).toEqual({ handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });
    expect(h.sends).toHaveLength(before + 2); expect(h.state.writes).toHaveLength(1);
    expect(h.sends.at(-1)).toMatchObject({ to: group, text: "Your request was submitted and is awaiting approval in Seerr." });
    expect(h.state.writes[0].headers.get("X-Api-User")).toBe("7");
    expect(h.state.writes[0].body).not.toHaveProperty("userId");
    expect(h.recordProcessed).toHaveBeenCalledExactlyOnceWith("completed", { reason: "thinkarr_confirmation_handled" });
    expect(h.markIdle).toHaveBeenCalledExactlyOnceWith("message_completed");
    expect(h.logs().some((r) => r.stage === "confirmation.native_context_verified")).toBe(true);
    expect(h.logs().find((r) => r.stage === "confirmation.result")).toMatchObject({ outcome: "pending_approval" });
    expect(h.logs().find((r) => r.stage === "lifecycle.work_settled" && r.workKind === "group_hook")).toMatchObject({ trackedWorkCount: 0, workStage: "operation.completed" });
    for (const secret of [group, canonical, sender, prompt.messageId, prompt.text, h.f.credential.token, h.f.privateKeyPem]) expect(JSON.stringify(h.logs())).not.toContain(secret);
  });
  it.each([
    ["missing-native-group", { From: undefined, ChatId: undefined, OriginatingTo: undefined, SessionKey: `agent:thinkarr:whatsapp:group:${group}` }, {}],
    ["other-group", { From: "120300000001@g.us" }, {}],
    ["chat-mismatch", { ChatId: "120300000001@g.us" }, {}],
    ["origin-mismatch", { OriginatingTo: "120300000001@g.us" }, {}],
    ["receiver-mismatch", { To: "+15555550200" }, {}],
    ["unknown-account", { AccountId: "other" }, {}],
    ["route-account", {}, { originatingAccountId: "other" }],
    ["route-target", {}, { originatingTo: "120300000001@g.us" }],
    ["not-admitted", { InboundAccessAuthorized: false }, {}],
    ["observed-room", { InboundEventKind: "room_event" }, {}],
    ["denied-delivery", {}, { sendPolicy: "deny" }],
    ["suppressed-delivery", {}, { sourceReplyDeliveryMode: "automatic", suppressUserDelivery: true }],
    ["unknown-suppressed-delivery", {}, { sourceReplyDeliveryMode: undefined, suppressUserDelivery: true }],
    ["synthetic-input", { InputProvenance: { kind: "progress-card-refresh" } }, {}],
    ["internal-turn", { InternalTurnSource: "automation" }, {}],
    ["self", { SenderIsSelf: true }, {}],
    ["bot", { SenderIsBot: true }, {}],
    ["unsupported-sender", { SenderId: "12345@lid" }, {}],
    ["stale-event", { Timestamp: 0 }, {}],
    ["missing-event", { MessageSid: undefined }, {}],
    ["tail", {}, { isTailDispatch: true }],
  ] as const)("does not submit or reply from unsafe native confirmation context: %s", async (_name, nativePatch, eventPatch) => {
    const h = await fixture(); await h.select(); const before = h.sends.length;
    const source = h.nativeEvent("request it");
    // Evaluate timestamps inside the fake-clock fixture, not at file import.
    const patch = _name === "stale-event" ? { ...nativePatch, Timestamp: Date.now() - 901_000 } : nativePatch;
    const event = { ...source, ...eventPatch, ctx: { ...source.ctx, ...patch } } as GroupReplyEvent;
    expect(await h.dispatchNative(event)).toBeUndefined();
    expect(h.state.writes).toHaveLength(0); expect(h.sends).toHaveLength(before);
    expect(h.recordProcessed).not.toHaveBeenCalled(); expect(h.markIdle).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpMediaSelections).get()).toMatchObject({ state: "pending" });
  });
  it("accepts only matching channel-prefixed native group facts and exact native quotes", async () => {
    const h = await fixture(); await h.select(); const prompt = h.sends.at(-1)!;
    const source = h.nativeEvent("yes", "quote", Date.now(), prompt.messageId);
    const event: GroupReplyEvent = { ...source, originatingTo: `whatsapp:${group}`, ctx: { ...source.ctx,
      From: `whatsapp:${group}`, ChatId: `whatsapp:${group}`, OriginatingTo: `whatsapp:${group}`, To: group,
    } };
    const explicitlyNotQuote = { ...event, ctx: { ...event.ctx, ReplyToIsQuote: false, SupplementalContext: undefined } };
    expect(await h.dispatchNative(explicitlyNotQuote)).toBeUndefined(); expect(h.state.writes).toHaveLength(0);
    const conflicting = { ...event, ctx: { ...event.ctx, ReplyToIsQuote: true, SupplementalContext: { quote: { id: "other-prompt" } } } };
    expect(await h.dispatchNative(conflicting)).toBeUndefined(); expect(h.state.writes).toHaveLength(0);
    expect(await h.dispatchNative(event)).toMatchObject({ handled: true, queuedFinal: true }); expect(h.state.writes).toHaveLength(1);
  });
  it.each(["request it", "yes"])("accepts the pinned native reply ID without optional quote-body/flag metadata (%s)", async (text) => {
    const h = await fixture(); await h.select(); const prompt = h.sends.at(-1)!;
    const source = h.nativeEvent(text, "native-id-only", Date.now(), prompt.messageId);
    expect(await h.dispatchNative({ ...source, ctx: { ...source.ctx, SupplementalContext: undefined, ReplyToIsQuote: undefined } })).toMatchObject({ handled: true, queuedFinal: true });
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].headers.get("X-Api-User")).toBe("7");
    expect(h.state.writes[0].body).not.toHaveProperty("userId");
  });
  it("keeps an unrelated native reply ID unclaimed without optional quote metadata", async () => {
    const h = await fixture(); await h.select(); const before = h.sends.length;
    const source = h.nativeEvent("yes", "finance-native-id", Date.now(), "finance-prompt");
    expect(await h.dispatchNative({ ...source, ctx: { ...source.ctx, SupplementalContext: undefined } })).toBeUndefined();
    expect(h.state.writes).toHaveLength(0); expect(h.sends).toHaveLength(before);
  });
  it("blocks a model follow-up send only after the real native prompt is acknowledged in the same turn", async () => {
    const h = await fixture(true, true);
    const duplicate = { action: "send", target: group, channel: "whatsapp", message: "A confirmation prompt has been sent. Follow that prompt." };
    await h.beforeTool("thinkarr_media_select", {});
    expect(await h.beforeTool("message", duplicate)).toBeUndefined();
    expect((await h.select()).details.status).toBe("prompt_sent");
    expect(await h.beforeTool("message", duplicate)).toMatchObject({ block: true });
    expect(await h.beforeTool("message", { ...duplicate, media: "", mediaUrls: [], buttons: [] })).toMatchObject({ block: true });
    expect(await h.beforeTool("message", duplicate, "next-user-turn")).toBeUndefined();
    expect(await h.beforeTool("message", { ...duplicate, target: "120300000099@g.us" })).toBeUndefined();
    await h.beforeTool("splitwise_get_balances", {});
    expect(await h.beforeTool("message", duplicate)).toBeUndefined();
    expect(h.state.writes).toHaveLength(0);
  });
  it("cancels automatic text for the exact presented turn while preserving other routes, media, errors and later turns", async () => {
    const h = await fixture(); await h.beforeTool("thinkarr_media_select", {}); await h.select();
    const event: ReplyPayloadEvent = { runId: "run-pilot", sessionKey: "session-pilot", channel: "whatsapp", kind: "final", payload: { text: "Follow that prompt to submit your request." } };
    const ctx: MessageHookContext = { channelId: "whatsapp", accountId: "account-A", conversationId: group, sessionKey: "session-pilot" };
    expect(await h.guardReply(event, ctx)).toMatchObject({ cancel: true });
    for (const changed of [ { ...event, runId: undefined }, { ...event, runId: "new-turn" }, { ...event, sessionKey: "other-session" },
      { ...event, payload: { ...event.payload, isError: true } }, { ...event, payload: { ...event.payload, presentation: { title: "Widget" } } },
      { ...event, payload: { ...event.payload, mediaUrl: "https://media.invalid/item" } } ]) {
      expect(await h.guardReply(changed, ctx)).toBeUndefined();
    }
    expect(await h.guardReply(event, { ...ctx, accountId: "other" })).toBeUndefined();
    expect(await h.guardReply(event, { ...ctx, conversationId: "120300000099@g.us" })).toBeUndefined();
    await h.beforeTool("splitwise_get_balances", {});
    expect(await h.guardReply(event, ctx)).toBeUndefined();
  });
  it("does not suppress a failure, an expired presentation guard or a mixed-workflow turn", async () => {
    const h = await fixture();
    const send = { action: "send", target: group, channel: "whatsapp", message: "A useful response" };
    await h.beforeTool("thinkarr_media_select", {}); h.state.failDelivery = true;
    expect((await h.select()).details.status).toBe("failed");
    expect(await h.beforeTool("message", send)).toBeUndefined();
    h.state.failDelivery = false;
    await h.beforeTool("splitwise_get_balances", {}); await h.beforeTool("thinkarr_media_select", {}); await h.select();
    expect(await h.beforeTool("message", send)).toBeUndefined();
    await h.beforeTool("thinkarr_media_select", {}, "media-only-run"); await h.select();
    expect(await h.beforeTool("message", send, "media-only-run")).toMatchObject({ block: true });
    vi.setSystemTime(Date.now() + 120_001);
    expect(await h.beforeTool("message", send, "media-only-run")).toBeUndefined();
  });
  it("does not suppress another account, recipient, action or rich message in a presentation turn", async () => {
    const h = await fixture(); await h.beforeTool("thinkarr_media_select", {}); await h.select();
    const send = { action: "send", target: group, channel: "whatsapp", message: "Text" };
    for (const patch of [{ accountId: "other" }, { target: "+15555550200" }, { channel: "telegram" }, { action: "react" },
      { media: "https://media.invalid/item" }, { filePath: "file" }, { presentation: {} }, { target: undefined }]) {
      expect(await h.beforeTool("message", { ...send, ...patch })).toBeUndefined();
    }
  });
  it("rejects old native-only quote IDs after a replacement prompt and accepts only the current one", async () => {
    const h = await fixture(); await h.select(); const old = h.sends.at(-1)!.messageId;
    await h.select({ id: 124, mediaType: "movie" }); const current = h.sends.at(-1)!.messageId;
    const source = h.nativeEvent("request it", "old-native-only", Date.now(), old);
    expect(await h.dispatchNative({ ...source, ctx: { ...source.ctx, SupplementalContext: undefined } })).toMatchObject({ handled: true });
    expect(h.state.writes).toHaveLength(0);
    const correct = h.nativeEvent("request it", "current-native-only", Date.now(), current);
    expect(await h.dispatchNative({ ...correct, ctx: { ...correct.ctx, SupplementalContext: undefined } })).toMatchObject({ handled: true });
    expect(h.state.writes).toHaveLength(1); expect(h.state.writes[0].body.mediaId).toBe(124);
  });
  it("cancels a closed native turn before any request or result delivery", async () => {
    const h = await fixture(); await h.select(); const before = h.sends.length;
    expect(await h.dispatchNative(h.nativeEvent("request it"), { cfg: {}, abortSignal: AbortSignal.abort() })).toMatchObject({ handled: true, queuedFinal: false });
    expect(h.state.writes).toHaveLength(0); expect(h.sends).toHaveLength(before);
  });
  it.each(["acp", undefined] as const)("does not take over an ACP/background or unknown dispatch owner (%s)", async (dispatchKind) => {
    const h = await fixture(); await h.select(); const before = h.sends.length;
    expect(await h.dispatchNative(h.nativeEvent("request it"), { dispatchKind })).toBeUndefined();
    expect(h.state.writes).toHaveLength(0); expect(h.sends).toHaveLength(before);
    expect(h.recordProcessed).not.toHaveBeenCalled();
  });
  it("reports a lost confirmation response as unknown after one real request without retrying", async () => {
    const h = await fixture(true, true); await h.select(); h.state.loseConfirmationResponse = true;
    expect(await h.dispatch("request it")).toMatchObject({ handled: true, text: expect.stringContaining("could not verify") });
    expect(h.state.writes).toHaveLength(1);
    expect(db.select().from(schema.mcpMediaSelections).get()).toMatchObject({ state: "completed", outcome: "pending_approval" });
    expect(h.logs().find((r) => r.stage === "confirmation.result")).toMatchObject({ outcome: "unknown" });
  });
  it("does not fall through or send a duplicate result if host bookkeeping fails after a real submission", async () => {
    const h = await fixture(true, true); await h.select(); const before = h.sends.length; const idle = vi.fn();
    const result = await h.dispatchNative(h.nativeEvent("request it"), { cfg: {}, recordProcessed: () => { throw new Error("SECRET bookkeeping failure"); }, markIdle: idle });
    expect(result).toMatchObject({ handled: true, queuedFinal: true, counts: { final: 1 } });
    expect(h.state.writes).toHaveLength(1); expect(h.sends).toHaveLength(before + 1);
    expect(idle).toHaveBeenCalledExactlyOnceWith("message_completed");
    expect(h.logs().some((r) => r.stage === "confirmation.record_unconfirmed")).toBe(true);
    expect(JSON.stringify(h.logs())).not.toContain("SECRET bookkeeping failure");
  });
  it("does not label an accepted request as failed or retry when the native turn closes after dispatch", async () => {
    const h = await fixture(true, true); await h.select(); const before = h.sends.length; const abort = new AbortController();
    h.state.afterWrite = () => abort.abort();
    expect(await h.dispatchNative(h.nativeEvent("request it"), { cfg: {}, abortSignal: abort.signal })).toMatchObject({ handled: true, queuedFinal: false });
    expect(h.state.writes).toHaveLength(1); expect(h.sends).toHaveLength(before);
    expect(h.logs().find((r) => r.stage === "confirmation.result")).toMatchObject({ outcome: "unknown" });
    expect(h.logs().find((r) => r.stage === "confirmation.reply_unconfirmed")).toBeDefined();
  });
  it("links privately, searches safe existing catalog facts, presents a real prompt and submits only after native confirmation", async () => {
    const h = await fixture(true, true);
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
    const stages = h.logs().map((r) => r.stage);
    for (const stage of ["media.presentation_validate", "outbound.prompt_adapter", "outbound.prompt_dispatch", "outbound.prompt_receipt", "media.presentation_acknowledge", "media.outcome_validate"]) expect(stages).toContain(stage);
    expect(h.logs().find((r) => r.operation === "media_confirm_request" && r.stage === "operation.completed")).toMatchObject({ outcome: "pending_approval" });
    const rawLogs = JSON.stringify(h.logs());
    for (const value of ["SECRET", "Movie 123", "request it", sender, canonical, group, h.f.credential.token, h.f.privateKeyPem, ...h.sends.map((s) => s.text)]) expect(rawLogs).not.toContain(value);
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

  it("requires linking, an enabled integration and its saved group", async () => {
    const h = await fixture(false);
    expect((await h.tool("thinkarr_media_search", { query: "Movie" })).details.status).toBe("failed");
    expect((await h.raw("account_link_start", {}, { conversation: "another@g.us" })).status).toBe(403);
    updateIntegration(h.f.principal.id, { enabled: false }, adminId);
    expect((await h.raw("account_link_start")).status).toBe(403);
    expect(() => updateIntegration(h.f.principal.id, { enabled: true, pilotGroup: null }, adminId)).toThrow("Configure the WhatsApp group");
  });

  it("uses saved settings even when obsolete pilot environment variables disagree", async () => {
    const h = await fixture();
    vi.stubEnv("THINKARR_MCP_PILOT_PRINCIPAL", "another-principal"); vi.stubEnv("THINKARR_MCP_PILOT_GROUP", "another@g.us");
    expect((await h.select()).details.status).toBe("prompt_sent");
    expect(await h.dispatch("request it")).toMatchObject({ text: expect.stringContaining("awaiting approval") });
  });

  it("invalidates pending links, active bindings and selections when the configured group changes", async () => {
    const h = await fixture(); await h.select();
    const pending = initiateAccountLink(await h.f.context({ sender: "another-participant", conversation: group }));
    if (pending.linked) throw new Error("Unexpected fixture binding");
    const binding = db.select().from(schema.mcpActorBindings).get()!;
    updateIntegration(h.f.principal.id, { pilotGroup: "120300000001@g.us" }, adminId);
    expect(db.select().from(schema.mcpActorBindings).get()).toMatchObject({ version: binding.version + 1, revokedAt: expect.any(Date) });
    expect(() => prepareAccountLink(pending.token, h.f.sessionA, h.f.userA)).toThrow("expired");
    expect((await h.raw("media_search", { query: "Movie" })).status).toBe(403);
    // Changing back cannot resurrect the old binding or human confirmation.
    updateIntegration(h.f.principal.id, { pilotGroup: group }, adminId);
    expect(await h.dispatch("request it")).toMatchObject({ text: expect.stringContaining("could not be completed") });
    expect(h.state.writes).toHaveLength(0);
  });

  it("does not revoke participant links when saving the same group and ordinary settings", async () => {
    const h = await fixture(); await h.select();
    const binding = db.select().from(schema.mcpActorBindings).get()!;
    updateIntegration(h.f.principal.id, { name: "Renamed integration", pilotGroup: group }, adminId);
    expect(db.select().from(schema.mcpActorBindings).get()).toMatchObject({ version: binding.version, revokedAt: null });
    expect(await h.dispatch("request it")).toMatchObject({ text: expect.stringContaining("awaiting approval") });
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
