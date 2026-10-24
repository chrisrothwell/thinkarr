import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";
import { createLinkingConnector, type LinkingConnectorConfig, type PrivateLinkDelivery, type TrustedLinkInvocation } from "../../../connectors/delegated-mcp/linking";
import { createDiagnosticTrace } from "../../../connectors/delegated-mcp/diagnostics";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({
  getOpenAITools: vi.fn(() => []), hasTools: () => true, executeTool: vi.fn(),
}));
import { POST } from "@/app/api/mcp/route";
import { prepareAccountLink, resolveServiceActor } from "@/lib/mcp/account-linking";
import { getDelegationAudience } from "@/lib/mcp/delegation";
import { revokeServiceCredential } from "@/lib/mcp/service-principals";
import { executeTool, getOpenAITools } from "@/lib/tools/registry";
import { initializeTools } from "@/lib/tools/init";

const actor = (patch: Partial<TrustedLinkInvocation> = {}): TrustedLinkInvocation => ({
  channel: "whatsapp", account: "account-A", sender: "sender-A", kind: "group", conversation: "group-A",
  assertCurrent: vi.fn(), ...patch,
});
const receipt = (d: PrivateLinkDelivery) => ({ accepted: true as const, channel: d.channel, account: d.account, recipient: d.recipient, messageId: "provider-private-message" });
const routeFetch: typeof fetch = (input, init) => POST(new Request(input, init));
function fakeDeadlineSignals() {
  vi.useFakeTimers();
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}
function untilAborted(signal: AbortSignal, onAbort: () => void = () => {}) {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => { onAbort(); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

beforeEach(() => {
  ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
  vi.clearAllMocks();
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); });

async function fixture() {
  const f = await delegatedLinkFixture(db, adminId);
  const config: LinkingConnectorConfig = {
    endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
    service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(),
    keyId: f.key.keyId, bearer: f.credential.token, privateKeyPem: f.privateKeyPem,
  };
  return { f, config };
}

describe("trusted linking connector core", () => {
  it.each([401, 403, 500])("logs HTTP %s without leaking response bodies or auth headers", async (status) => {
    const { config } = await fixture(); const lines: string[] = [];
    const trace = createDiagnosticTrace({ info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) }, false, "link_start");
    const connector = await createLinkingConnector(config, { diagnostics: trace.log, sendPrivate: async (d) => receipt(d),
      fetch: async () => new Response(`SECRET BODY ${config.bearer}`, { status }),
    });
    expect(await connector.startLink(actor())).toEqual({ status: status >= 500 ? "unavailable" : "failed" });
    expect(lines.some((line) => line.includes('"stage":"mcp.http.response"') && line.includes(`"httpStatus":${status}`))).toBe(true);
    expect(lines.join()).not.toContain(config.bearer); expect(lines.join()).not.toContain("SECRET BODY");
  });
  it("classifies network failures without copying exception messages, URLs or causes", async () => {
    const { config } = await fixture(); const lines: string[] = [];
    const trace = createDiagnosticTrace({ info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) }, true, "link_start");
    const connector = await createLinkingConnector(config, { diagnostics: trace.log, sendPrivate: async (d) => receipt(d), fetch: async () => {
      throw new TypeError(`SECRET URL ${config.endpoint}`, { cause: Object.assign(new Error(config.bearer), { code: "ECONNREFUSED" }) });
    } });
    expect(await connector.startLink(actor())).toEqual({ status: "unavailable" });
    expect(lines.some((line) => line.includes('"stage":"mcp.http.fetch"') && line.includes('"errorCode":"ECONNREFUSED"'))).toBe(true);
    expect(lines.join()).not.toContain("SECRET URL"); expect(lines.join()).not.toContain(config.endpoint); expect(lines.join()).not.toContain(config.bearer);
  });
  it.each(["known", "untrusted"])("logs bounded remote tool errors (%s)", async (kind) => {
    const { config } = await fixture(); const lines: string[] = [];
    const trace = createDiagnosticTrace({ info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) }, true, "link_start");
    const connector = await createLinkingConnector(config, { diagnostics: trace.log, sendPrivate: async (d) => receipt(d), fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method !== "tools/call") return routeFetch(input, init);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: kind === "known"
        ? "Configure the public linking origin and WhatsApp bot number before linking" : `SECRET REMOTE ${config.privateKeyPem}` }) }] } });
    } });
    expect(await connector.startLink(actor())).toEqual({ status: "failed" });
    expect(lines.join()).toContain(kind === "known" ? "remote_link_configuration_required" : "remote_tool_error");
    expect(lines.join()).not.toContain("SECRET REMOTE"); expect(lines.join()).not.toContain(config.privateKeyPem);
  });
  it("allows a slow but bounded handshake longer than fifteen seconds and rejects the optional SSE probe locally", async () => {
    const { config } = await fixture(); const timeout = fakeDeadlineSignals();
    const started = Promise.withResolvers<void>(); const requests: string[] = [];
    const connector = await createLinkingConnector(config, { sendPrivate: async (d) => receipt(d), fetch: async (input, init) => {
      expect(init?.method).toBe("POST"); // Standalone SSE GET never reaches the network.
      const method = JSON.parse(String(init?.body)).method; requests.push(method);
      const response = await routeFetch(input, init);
      if (method === "initialize") { started.resolve(); await new Promise((resolve) => setTimeout(resolve, 22_000)); }
      return response;
    } });
    try {
      let settled = false; const pending = connector.startLink(actor()).then((result) => { settled = true; return result; });
      await started.promise; await vi.advanceTimersByTimeAsync(16_000); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await pending).toEqual({ status: "private_link_sent" });
      expect(requests).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    } finally { timeout.mockRestore(); }
  });
  it("reports an unavailable handshake without submitting verification or creating a binding", async () => {
    const { config } = await fixture(); const timeout = fakeDeadlineSignals(); const notification = Promise.withResolvers<void>();
    let toolCalls = 0; let aborted = false;
    const connector = await createLinkingConnector(config, { sendPrivate: async (d) => receipt(d), fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/call") toolCalls++;
      if (body.method === "notifications/initialized") { notification.resolve(); return untilAborted(init!.signal!, () => { aborted = true; }); }
      return routeFetch(input, init);
    } });
    try {
      const pending = connector.handlePrivateLinkMessage({ ...actor({ kind: "direct" }), eventId: "verification", eventTime: Date.now() }, `Link account ${"a".repeat(64)}`);
      await notification.promise; await vi.advanceTimersByTimeAsync(45_001);
      expect(await pending).toEqual({ status: "unavailable" }); expect(aborted).toBe(true); expect(toolCalls).toBe(0);
      expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    } finally { timeout.mockRestore(); }
  });
  it("preserves an uncertain committed verification outcome and cancels the underlying HTTP request without retrying", async () => {
    const { f, config } = await fixture(); let holdConfirmation = false; let calls = 0; let aborted = false;
    const submitted = Promise.withResolvers<void>(); const deliveries: PrivateLinkDelivery[] = [];
    const connector = await createLinkingConnector(config, { sendPrivate: async (d) => { deliveries.push(d); return receipt(d); }, fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)); const response = await routeFetch(input, init);
      if (holdConfirmation && body.method === "tools/call") { calls++; submitted.resolve(); return untilAborted(init!.signal!, () => { aborted = true; }); }
      return response;
    } });
    await connector.startLink(actor());
    const code = prepareAccountLink(new URL(deliveries[0].url).hash.slice(7), f.sessionA, f.userA).completionCode;
    const timeout = fakeDeadlineSignals(); holdConfirmation = true;
    try {
      const pending = connector.handlePrivateLinkMessage({ ...actor({ kind: "direct" }), eventId: "commit-then-timeout", eventTime: Date.now() }, `Link account ${code}`);
      await submitted.promise;
      expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await pending).toEqual({ status: "unknown" }); expect(calls).toBe(1); expect(aborted).toBe(true);
      expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(1);
    } finally { timeout.mockRestore(); }
  });
  it("signs real SDK requests, privately delivers the handoff and completes browser verification", async () => {
    const { f, config } = await fixture();
    const captured: Array<{ method: string; claims: ReturnType<typeof decodeJwt> }> = [];
    const sendPrivate = vi.fn(async (delivery: PrivateLinkDelivery) => receipt(delivery));
    const connector = await createLinkingConnector(config, {
      sendPrivate,
      fetch: async (input, init) => {
        expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
        const request = new Request(input, init);
        const raw = await request.clone().text();
        const claims = decodeJwt(request.headers.get("Thinkarr-Delegation")!);
        expect(claims.bodyHash).toBe(createHash("sha256").update(raw).digest("hex"));
        expect(claims).toMatchObject({ method: "POST", target: "/api/mcp", aud: config.audience, service: config.service });
        captured.push({ method: JSON.parse(raw).method, claims });
        return POST(request);
      },
    });
    const result = await connector.startLink(actor());
    expect(result).toEqual({ status: "private_link_sent" });
    expect(captured.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(new Set(captured.map((r) => r.claims.jti)).size).toBe(3);
    expect(captured.every((r) => r.claims.source === "tool")).toBe(true);
    const delivery = sendPrivate.mock.calls[0][0];
    expect(delivery).toMatchObject({ channel: "whatsapp", account: "account-A", recipient: "sender-A" });
    expect(() => delivery.assertCurrent()).toThrow("Closed connector invocation");
    const token = new URL(delivery.url).hash.slice("#token=".length);
    const code = prepareAccountLink(token, f.sessionA, f.userA).completionCode;
    const completed = await connector.handlePrivateLinkMessage({
      ...actor({ kind: "direct", conversation: "private-A" }), eventId: "provider-event", eventTime: Date.now(),
    }, `Link account ${code}`);
    expect(completed).toEqual({ status: "linked" });
    expect(captured.slice(3).every((r) => r.claims.source === "message" && r.claims.intent === `link-confirm:${code}` && r.claims.eventId === "provider-event")).toBe(true);
    expect(resolveServiceActor(await f.context()).actorUserId).toBe(f.userA);
    expect(sendPrivate).toHaveBeenCalledTimes(1);
    for (const secret of [delivery.url, token, code, config.bearer, "sender-A", "account-A", "provider-private-message"]) {
      expect(JSON.stringify([result, completed])).not.toContain(secret);
    }
    expect(initializeTools).not.toHaveBeenCalled(); expect(getOpenAITools).not.toHaveBeenCalled(); expect(executeTool).not.toHaveBeenCalled();
  });

  it("isolates concurrent actors/conversations and snapshots host invocation and configuration", async () => {
    const { config } = await fixture();
    const deliveries: PrivateLinkDelivery[] = [];
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => { deliveries.push(d); return receipt(d); });
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: routeFetch });
    const first = actor();
    const pending = connector.startLink(first);
    first.sender = "mutated-after-start"; first.account = "other-account";
    config.bearer = "thk_svc_changed"; config.issuer = "changed";
    const results = await Promise.all([pending, connector.startLink(actor({ sender: "sender-B" })), connector.startLink(actor({ conversation: "group-B" }))]);
    expect(results).toEqual(Array(3).fill({ status: "private_link_sent" }));
    expect(deliveries.map((d) => d.recipient).sort()).toEqual(["sender-A", "sender-A", "sender-B"]);
    expect(new Set(deliveries.map((d) => d.url)).size).toBe(3);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(3);
  });

  it("returns linked without another private send for an active origin binding", async () => {
    const { f, config } = await fixture();
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: routeFetch });
    await connector.startLink(actor());
    const code = prepareAccountLink(new URL(sendPrivate.mock.calls[0][0].url).hash.slice(7), f.sessionA, f.userA).completionCode;
    await connector.handlePrivateLinkMessage({ ...actor({ kind: "direct" }), eventId: "event-1", eventTime: Date.now() }, `Link account ${code}`);
    expect(await connector.startLink(actor())).toEqual({ status: "linked" });
    expect(sendPrivate).toHaveBeenCalledTimes(1);
  });

  it.each(["failed-send", "no-receipt", "wrong-account", "wrong-recipient", "revoked-after-send"])("sanitizes %s without retry or public fallback", async (mode) => {
    const { config } = await fixture();
    let live = true;
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => {
      d.assertCurrent();
      if (mode === "failed-send") throw new Error(d.url);
      if (mode === "revoked-after-send") live = false;
      return { ...receipt(d), ...(mode === "no-receipt" ? { messageId: "" } : {}),
        ...(mode === "wrong-account" ? { account: "other" } : {}), ...(mode === "wrong-recipient" ? { recipient: "other" } : {}) };
    });
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: routeFetch });
    expect(await connector.startLink(actor({ assertCurrent: () => { if (!live) throw new Error("expired"); } }))).toEqual({ status: "failed" });
    expect(sendPrivate).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong-target", "wrong-origin", "query-token", "expired", "extra-content", "extra-meta", "structured", "upstream-error"])("rejects %s in upstream results before private delivery", async (mode) => {
    const { config } = await fixture();
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, {
      sendPrivate,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const method = (await request.clone().json()).method;
        const response = await POST(request);
        if (method !== "tools/call") return response;
        const envelope = await response.json();
        const result = envelope.result;
        const delivery = result._meta["thinkarr/private-delivery"];
        if (mode === "wrong-target") delivery.recipient = "other";
        if (mode === "wrong-origin") delivery.url = delivery.url.replace("thinkarr.invalid", "attacker.invalid");
        if (mode === "query-token") delivery.url = delivery.url.replace("#token=", "?token=");
        if (mode === "expired") delivery.expiresAt = new Date(Date.now() - 1).toISOString();
        if (mode === "extra-content") result.content.push({ type: "text", text: delivery.url });
        if (mode === "extra-meta") result._meta.extra = delivery.url;
        if (mode === "structured") result.structuredContent = { secret: delivery.url };
        if (mode === "upstream-error") { result.isError = true; result.content[0].text = delivery.url; }
        return Response.json(envelope);
      },
    });
    expect(await connector.startLink(actor())).toEqual({ status: "failed" });
    expect(sendPrivate).not.toHaveBeenCalled();
  });

  it.each(["redirect", "expired-before-fetch", "expired-after-fetch", "revoked-credential", "cancelled"])("fails closed on %s", async (mode) => {
    const { f, config } = await fixture();
    let live = true;
    const controller = new AbortController();
    if (mode === "cancelled") controller.abort();
    if (mode === "expired-before-fetch") live = false;
    if (mode === "revoked-credential") revokeServiceCredential(f.principal.id, f.credential.id, adminId);
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, {
      sendPrivate, fetch: async (input, init) => {
        if (mode === "redirect") return new Response(null, { status: 307, headers: { Location: "https://attacker.invalid" } });
        const result = await routeFetch(input, init);
        if (mode === "expired-after-fetch") live = false;
        return result;
      },
    });
    expect(await connector.startLink(actor({ signal: controller.signal, assertCurrent: () => { if (!live) throw new Error("stale invocation"); } }))).toEqual({ status: "failed" });
    expect(sendPrivate).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
  });

  it("leaves unrelated messages unclaimed and rejects group/missing/stale event proof", async () => {
    const { config } = await fixture();
    const fetchRequest = vi.fn(routeFetch);
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: fetchRequest });
    const message = { ...actor({ kind: "direct" }), eventId: randomUUID(), eventTime: Date.now() };
    for (const text of ["yes", "request it", "split the bill", "quoted Link account " + "a".repeat(64), "Link account " + "a".repeat(101)]) {
      expect(await connector.handlePrivateLinkMessage(message, text)).toBeUndefined();
    }
    for (const patch of [{ kind: "group" as const }, { eventId: "" }, { eventTime: Date.now() - 901_000 }, { eventTime: Date.now() + 6000 }]) {
      expect(await connector.handlePrivateLinkMessage({ ...message, ...patch }, `Link account ${"a".repeat(64)}`)).toEqual({ status: "failed" });
    }
    expect(fetchRequest).not.toHaveBeenCalled(); expect(sendPrivate).not.toHaveBeenCalled();
  });

  it("rechecks live authority after private-target preparation before physical send", async () => {
    const { config } = await fixture();
    let live = true;
    const physicalSend = vi.fn();
    const connector = await createLinkingConnector(config, {
      fetch: routeFetch,
      sendPrivate: async (delivery) => {
        await Promise.resolve();
        live = false;
        delivery.assertCurrent();
        physicalSend();
        return receipt(delivery);
      },
    });
    expect(await connector.startLink(actor({ assertCurrent: () => { if (!live) throw new Error("stale"); } }))).toEqual({ status: "failed" });
    expect(physicalSend).not.toHaveBeenCalled();
  });

  it("requires complete trusted identity and a live guard before any request", async () => {
    const { config } = await fixture();
    const fetchRequest = vi.fn(routeFetch);
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: fetchRequest });
    for (const patch of [{ sender: "" }, { account: "" }, { conversation: "" }, { channel: "other" }, { kind: undefined }, { assertCurrent: undefined }]) {
      expect(await connector.startLink({ ...actor(), ...patch } as TrustedLinkInvocation)).toEqual({ status: "failed" });
    }
    expect(fetchRequest).not.toHaveBeenCalled(); expect(sendPrivate).not.toHaveBeenCalled();
  });

  it("does not allow another sender or fresh-nonce replay to complete a prepared link", async () => {
    const { f, config } = await fixture();
    const sendPrivate = vi.fn(async (d: PrivateLinkDelivery) => receipt(d));
    const connector = await createLinkingConnector(config, { sendPrivate, fetch: routeFetch });
    await connector.startLink(actor());
    const code = prepareAccountLink(new URL(sendPrivate.mock.calls[0][0].url).hash.slice(7), f.sessionA, f.userA).completionCode;
    const message = { ...actor({ kind: "direct" }), eventId: "event-1", eventTime: Date.now() };
    expect(await connector.handlePrivateLinkMessage({ ...message, sender: "other" }, `Link account ${code}`)).toEqual({ status: "failed" });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(await connector.handlePrivateLinkMessage(message, `Link account ${code}`)).toEqual({ status: "linked" });
    expect(await connector.handlePrivateLinkMessage(message, `Link account ${code}`)).toEqual({ status: "failed" });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(1);
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(1);
    // The source origin remains the group, not the private completion chat.
    expect(db.select().from(schema.mcpActorBindings).where(eq(schema.mcpActorBindings.userId, f.userA)).get()!.contextKind).toBe("group");
  });

  it.each(["http://example.com/api/mcp", "https://user:secret@thinkarr.invalid/api/mcp", "https://thinkarr.invalid/api/other", "https://thinkarr.invalid/api/mcp?mode=text"])("rejects unsafe endpoint %s", async (endpoint) => {
    const { config } = await fixture();
    await expect(createLinkingConnector({ ...config, endpoint }, { sendPrivate: async (d) => receipt(d) })).rejects.toThrow("Invalid linking connector configuration");
  });
});
