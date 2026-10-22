import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import Ajv from "ajv";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";
import { canonicalPhone, register } from "../../../connectors/openclaw/index";
import type { DispatchContext, DispatchEvent, DispatchResult, OpenClawHost, Outbound, ToolContext } from "../../../connectors/openclaw/host";
import manifest from "../../../connectors/openclaw/openclaw.plugin.json";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
let directory: string;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ getOpenAITools: vi.fn(() => []), hasTools: () => true, executeTool: vi.fn() }));
import { POST } from "@/app/api/mcp/route";
import { getDelegationAudience } from "@/lib/mcp/delegation";
import { prepareAccountLink, resolveServiceActor } from "@/lib/mcp/account-linking";

const sender = "+15555550101";
const group = "120300000000@g.us";
const toolContext = (patch: Partial<ToolContext<object>> = {}): ToolContext<object> => ({
  messageChannel: "whatsapp", agentAccountId: "account-A", requesterSenderId: sender, nativeChannelId: group,
  assertInvocationCurrent: vi.fn(), ...patch,
});

beforeEach(async () => {
  ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true });
  directory = await mkdtemp(join(tmpdir(), "thinkarr-openclaw-"));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => POST(new Request(input, init))));
});
afterEach(async () => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const f = await delegatedLinkFixture(db, adminId);
  const credentialsFile = join(directory, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({
    endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
    service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(),
    keyId: f.key.keyId, bearer: f.credential.token, privateKeyPem: f.privateKeyPem,
  }), { mode: 0o600 });
  const lifecycle = new AbortController();
  let factory: Parameters<OpenClawHost<object>["registerTool"]>[0] | undefined;
  let hook: ((event: DispatchEvent, context: DispatchContext) => Promise<DispatchResult | void>) | undefined;
  const sends: Array<Parameters<NonNullable<Outbound<object>["sendText"]>>[0]> = [];
  const outbound: Outbound<object> = {
    resolveTarget: vi.fn(({ to }: { to: string }) => ({ ok: true as const, to })),
    sendText: vi.fn(async (params) => {
      await params.onPlatformSendDispatch();
      sends.push(params);
      return { channel: "whatsapp", messageId: "provider-message", toJid: canonicalPhone(params.to) };
    }),
  };
  const api: OpenClawHost<object> = {
    registrationMode: "full", config: {},
    pluginConfig: { credentialsFile, accounts: { "account-A": "+15555550100" } },
    lifecycle: { signal: lifecycle.signal },
    runtime: { version: "2026.10.4", channel: { outbound: { loadAdapter: vi.fn(async () => outbound) } } },
    registerTool: vi.fn((tool) => { factory = tool; }),
    on: vi.fn((_name, handler) => { hook = handler; }),
  };
  return {
    f, api, outbound, sends, credentialsFile, lifecycle,
    create: (ctx = toolContext()) => factory!.create(ctx),
    dispatch: (event: DispatchEvent, context: DispatchContext) => hook!(event, context),
  };
}

describe("OpenClaw linking adapter", () => {
  it("declares every registered optional tool for manifest-first loading and activates the inbound hook at startup", async () => {
    const h = await fixture(); h.api.pluginConfig = { ...h.api.pluginConfig, pilotGroup: group }; register(h.api);
    const registrations = vi.mocked(h.api.registerTool).mock.calls;
    const names = registrations.flatMap(([, options]) => options.names).sort();
    expect(manifest.contracts.tools.toSorted()).toEqual(names);
    expect(Object.keys(manifest.toolMetadata).sort()).toEqual(names);
    expect(Object.values(manifest.toolMetadata).every((tool) => tool.optional)).toBe(true);
    expect(manifest.activation.onStartup).toBe(true);
    expect(h.api.on).toHaveBeenCalledWith("before_dispatch", expect.any(Function), expect.any(Object));
    // Owned/discoverable names do not create authority in a context-free catalog.
    for (const [registration] of registrations) {
      expect(registration.create(toolContext({ requesterSenderId: undefined }))).toBeNull();
      expect(registration.create(toolContext())?.name).toBeDefined();
    }
    expect(fetch).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(0);
  });
  it("declares native secret fields for platform materialization/redaction/audit and accepts only references in source config", async () => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    const validate = new Ajv().compile(manifest.configSchema);
    const source = { accounts: { "account-A": "+15555550100" }, connection: { ...connection,
      bearer: { source: "store", provider: "default", id: "THINKARR_SERVICE_TOKEN" },
      privateKeyPem: { source: "store", provider: "default", id: "THINKARR_PRIVATE_KEY" },
    } };
    expect(validate(source)).toBe(true);
    expect(validate({ ...source, connection })).toBe(false);
    expect(manifest.configContracts.secretInputs.paths.map((p) => p.path)).toEqual(["connection.bearer", "connection.privateKeyPem"]);
  });
  it("uses host-materialized native secrets without any credentials file and never returns them", async () => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, connection };
    await rm(h.credentialsFile); register(h.api);
    const result = await h.create()!.execute("native", {});
    expect(result.details.status).toBe("private_link_sent");
    expect(JSON.stringify(result)).not.toContain(connection.bearer); expect(JSON.stringify(result)).not.toContain(connection.privateKeyPem);
    h.lifecycle.abort(); expect((await h.create()!.execute("disposed", {})).details.status).toBe("failed");
  });
  it("fails closed when the host has not materialized a configured secret reference", async () => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    connection.bearer = { source: "store", provider: "default", id: "PROTECTED_TOKEN" };
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, connection };
    expect(() => register(h.api)).toThrow("Invalid Thinkarr plugin configuration"); expect(fetch).not.toHaveBeenCalled();
  });
  it("registers supported factory/hook, sends only to the sender privately and completes the real backend link", async () => {
    const h = await fixture(); register(h.api);
    expect(h.api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ contextVersion: 2 }), { names: ["thinkarr_account_link"], optional: true });
    expect(h.api.on).toHaveBeenCalledWith("before_dispatch", expect.any(Function), { timeoutMs: 20_000 });
    const ctx = toolContext({ deliveryContext: { channel: "whatsapp", accountId: "account-A", to: group } });
    const tool = h.create(ctx)!;
    // Host metadata is captured by the factory, never read from later model args.
    ctx.requesterSenderId = "+15555550999";
    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual({ status: "private_link_sent" });
    expect(h.sends).toHaveLength(1);
    const sent = h.sends[0];
    expect(sent.to).toBe("15555550101@s.whatsapp.net"); expect(sent.accountId).toBe("account-A");
    expect(sent.to).not.toBe(group);
    const url = sent.text.split(" ").at(-1)!;
    const code = prepareAccountLink(new URL(url).hash.slice(7), h.f.sessionA, h.f.userA).completionCode;
    const completed = await h.dispatch({
      content: `Link account ${code}`, channel: "whatsapp", senderId: sender, messageId: "incoming-verification", timestamp: Date.now(), isGroup: false,
    }, { channelId: "whatsapp", accountId: "account-A", conversationId: sender, senderId: "15555550101@s.whatsapp.net", messageId: "incoming-verification" });
    expect(completed).toEqual({ handled: true, text: "Your Plex account is linked." });
    expect(resolveServiceActor(await h.f.context({ sender: "15555550101@s.whatsapp.net", conversation: group })).actorUserId).toBe(h.f.userA);
    for (const value of [url, code, h.f.credential.token, h.f.privateKeyPem, "provider-message", sender]) {
      expect(JSON.stringify([result, completed])).not.toContain(value);
    }
  });

  it("isolates concurrent tool factories for two participants and contexts", async () => {
    const h = await fixture(); register(h.api);
    const outcomes = await Promise.all([
      h.create()!.execute("a", {}),
      h.create(toolContext({ requesterSenderId: "+15555550102" }))!.execute("b", {}),
      h.create(toolContext({ nativeChannelId: "120300000001@g.us" }))!.execute("c", {}),
    ]);
    expect(outcomes.map((r) => r.details.status)).toEqual(Array(3).fill("private_link_sent"));
    expect(h.sends.map((p) => p.to).sort()).toEqual(["15555550101@s.whatsapp.net", "15555550101@s.whatsapp.net", "15555550102@s.whatsapp.net"]);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(3);
  });

  it("rejects missing, ambiguous, self, LID and mismatched-route identities before exposing a tool", async () => {
    const h = await fixture(); register(h.api);
    for (const patch of [
      { messageChannel: "telegram" }, { agentAccountId: undefined }, { requesterSenderId: undefined },
      { requesterSenderId: "+15555550100" }, { requesterSenderId: "123456@lid" },
      { nativeChannelId: "session:group:guessed" }, { nativeChannelId: "+15555550999" },
      { deliveryContext: { to: "120300000001@g.us" } }, { deliveryContext: { accountId: "another" } },
      { assertInvocationCurrent: undefined },
    ]) expect(h.create(toolContext(patch as Partial<ToolContext<object>>))).toBeNull();
    expect(h.create(toolContext({ nativeChannelId: sender }))?.name).toBe("thinkarr_account_link");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects model identity/delivery overrides without reading credentials or dispatching MCP", async () => {
    const h = await fixture(); register(h.api);
    for (const args of [{ recipient: "other" }, { userId: adminId }, { source: "message" }, { code: "a".repeat(64) }]) {
      expect((await h.create()!.execute("x", args)).details).toEqual({ status: "failed" });
    }
    expect(fetch).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(0);
  });

  it.each(["group-target", "lid-target", "wrong-result", "missing-receipt", "no-dispatch-guard", "throw-after-send"])("fails safely on %s without a public fallback or send retry", async (mode) => {
    const h = await fixture();
    if (mode === "group-target" || mode === "lid-target") h.outbound.resolveTarget = () => ({ ok: true, to: mode === "group-target" ? group : "123456@lid" });
    else h.outbound.sendText = vi.fn(async (params) => {
      if (mode !== "no-dispatch-guard") await params.onPlatformSendDispatch();
      h.sends.push(params);
      if (mode === "throw-after-send") throw new Error(params.text);
      return { channel: "whatsapp", messageId: mode === "missing-receipt" ? "" : "message", toJid: mode === "wrong-result" ? group : params.to };
    });
    register(h.api);
    const result = await h.create()!.execute("x", {});
    expect(result.details).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("#token=");
    expect(h.sends).toHaveLength(["group-target", "lid-target"].includes(mode) ? 0 : 1);
  });

  it("rechecks authority after loading outbound adapter and at each physical-send fence", async () => {
    const h = await fixture();
    let live = true;
    h.outbound.sendText = vi.fn(async (params) => {
      await Promise.resolve(); live = false;
      await params.onPlatformSendDispatch(); h.sends.push(params);
      return { channel: "whatsapp", messageId: "message", toJid: params.to };
    });
    register(h.api);
    expect((await h.create(toolContext({ assertInvocationCurrent: () => { if (!live) throw new Error(); } }))!.execute("x", {})).details.status).toBe("failed");
    expect(h.sends).toHaveLength(0);
    live = true;
    h.api.runtime.channel.outbound.loadAdapter = async () => { live = false; return h.outbound; };
    expect((await h.create(toolContext({ assertInvocationCurrent: () => { if (!live) throw new Error(); } }))!.execute("x", {})).details.status).toBe("failed");
    expect(h.sends).toHaveLength(0);
  });

  it("blocks disposed/stale/cancelled invocations and unsafe credential files", async () => {
    const h = await fixture(); register(h.api);
    await chmod(h.credentialsFile, 0o644);
    expect((await h.create()!.execute("x", {})).details.status).toBe("failed");
    await chmod(h.credentialsFile, 0o600);
    const alias = join(directory, "alias.json"); await symlink(h.credentialsFile, alias);
    const other = { ...h.api, pluginConfig: { ...h.api.pluginConfig, credentialsFile: alias } }; register(other);
    expect((await h.create()!.execute("x", {})).details.status).toBe("failed");
    register(h.api);
    const cancelled = AbortSignal.abort();
    expect((await h.create()!.execute("x", {}, cancelled)).details.status).toBe("failed");
    expect((await h.create(toolContext({ assertInvocationCurrent: () => { throw new Error(); } }))!.execute("x", {})).details.status).toBe("failed");
    h.lifecycle.abort();
    expect((await h.create()!.execute("x", {})).details.status).toBe("failed");
    expect(fetch).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(0);
  });

  it("keeps finance/unrelated messages unclaimed and claims invalid link metadata without exposing codes", async () => {
    const h = await fixture(); register(h.api);
    const event: DispatchEvent = { content: `Link account ${"a".repeat(64)}`, channel: "whatsapp", senderId: sender, messageId: "event-1", timestamp: Date.now(), isGroup: false };
    const context: DispatchContext = { channelId: "whatsapp", accountId: "account-A", conversationId: sender, senderId: sender, messageId: "event-1" };
    for (const content of ["split dinner", "yes", "request it", "Link account not-a-code"]) expect(await h.dispatch({ ...event, content }, context)).toBeUndefined();
    expect(await h.dispatch({ ...event, channel: "telegram" }, { ...context, channelId: "telegram" })).toBeUndefined();
    for (const patch of [{ senderId: "+15555550102" }, { isGroup: true }, { isGroup: undefined }, { timestamp: Date.now() - 901_000 }, { messageId: "other" }, { channel: "telegram" }]) {
      const result = await h.dispatch({ ...event, ...patch }, context);
      expect(result).toMatchObject({ handled: true }); expect(JSON.stringify(result)).not.toContain("a".repeat(64));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not read credentials during discovery and rejects untested host versions", async () => {
    const h = await fixture();
    h.api.registrationMode = "discovery"; register(h.api);
    expect(h.api.registerTool).not.toHaveBeenCalled(); expect(h.api.on).not.toHaveBeenCalled();
    h.api.registrationMode = "tool-discovery"; register(h.api);
    expect(h.api.registerTool).toHaveBeenCalledTimes(1); expect(h.api.on).not.toHaveBeenCalled();
    h.api.runtime.version = "2026.10.5";
    expect(() => register(h.api)).toThrow("requires OpenClaw 2026.10.4");
    expect(fetch).not.toHaveBeenCalled();
  });
});
