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
import { loadPreparedSecretReader } from "../../../connectors/openclaw/secrets";

vi.mock("../../../connectors/openclaw/secrets", () => ({ loadPreparedSecretReader: vi.fn() }));

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
  vi.mocked(loadPreparedSecretReader).mockRejectedValue(new Error("unavailable"));
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => POST(new Request(input, init))));
});
afterEach(async () => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

async function fixture(debug = false) {
  const f = await delegatedLinkFixture(db, adminId);
  const credentialsFile = join(directory, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({
    endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
    service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(),
    keyId: f.key.keyId, bearer: f.credential.token, privateKeyPem: f.privateKeyPem,
  }), { mode: 0o600 });
  const lifecycle = new AbortController();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logs = () => [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map(([line]) => JSON.parse(line.slice("[thinkarr] ".length)));
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
    pluginConfig: { credentialsFile, accounts: { "account-A": "+15555550100" }, debug }, logger,
    lifecycle: { signal: lifecycle.signal },
    runtime: { version: "2026.10.4", channel: { outbound: { loadAdapter: vi.fn(async () => outbound) } } },
    registerTool: vi.fn((tool) => { factory = tool; }),
    on: vi.fn((_name, handler) => { hook = handler; }),
  };
  return {
    f, api, outbound, sends, credentialsFile, lifecycle, logger, logs,
    create: (ctx = toolContext()) => factory!.create(ctx),
    dispatch: (event: DispatchEvent, context: DispatchContext) => hook!(event, context),
  };
}

async function prepareVerification(h: Awaited<ReturnType<typeof fixture>>) {
  expect((await h.create()!.execute("prepare", {})).details.status).toBe("private_link_sent");
  const url = h.sends[0].text.split(" ").at(-1)!;
  const code = prepareAccountLink(new URL(url).hash.slice(7), h.f.sessionA, h.f.userA).completionCode;
  const event: DispatchEvent = { content: `Link account ${code}`, channel: "whatsapp", senderId: sender, messageId: "private-verification", timestamp: Date.now(), isGroup: false };
  // Pinned WhatsApp hook mapper selects the receiving bot address as the DM
  // conversation, while the authenticated SenderId is the human participant.
  const context: DispatchContext = { channelId: "whatsapp", accountId: "account-A", conversationId: "+15555550100", senderId: canonicalPhone(sender), messageId: event.messageId };
  return { event, context, code };
}

describe("OpenClaw linking adapter", () => {
  it.each(["missing", "lid", "other"])("directs the user to private instructions without claiming verified delivery or retrying an unsupported receipt (%s)", async (kind) => {
    const h = await fixture(true);
    const destination = kind === "missing" ? undefined : kind === "lid" ? "999999@lid" : "unrecognized-provider-target";
    h.outbound.sendText = vi.fn(async (params) => {
      await params.onPlatformSendDispatch(); h.sends.push(params);
      return { channel: "whatsapp", messageId: "accepted-message", toJid: destination };
    });
    register(h.api); const result = await h.create()!.execute("ambiguous-delivery", {});
    expect(result.details.status).toBe("private_delivery_unconfirmed");
    expect(result.content[0].text).toContain("check your private WhatsApp chat");
    expect(result.content[0].text).toContain("rather than requesting another one");
    expect(h.outbound.sendText).toHaveBeenCalledTimes(1); expect(h.sends).toHaveLength(1);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(h.sends[0].text.split(" ").at(-1)!);
    expect(h.logs().find((r) => r.stage === "outbound.private_receipt_checks")).toMatchObject({ receiptDestinationKind: kind, receiptDestinationSupported: false });
    if (destination) expect(JSON.stringify(h.logs())).not.toContain(destination);
  });
  it.each([false, true])("privately explains a connection timeout or uncertain verification result without requesting a replacement link (committed=%s)", async (committed) => {
    const h = await fixture(true); register(h.api); const { event, context } = await prepareVerification(h);
    let toolCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = JSON.parse(String(init?.body)).method;
      if (!committed) throw new DOMException("Timeout containing SECRET", "TimeoutError");
      const response = await POST(new Request(input, init));
      if (method === "tools/call") { toolCalls++; throw new DOMException("Lost response SECRET", "TimeoutError"); }
      return response;
    }));
    expect(await h.dispatch(event, context)).toEqual({ handled: true });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(committed ? 1 : 0);
    expect(toolCalls).toBe(committed ? 1 : 0); expect(h.sends).toHaveLength(2);
    expect(h.sends[1].text).toContain(committed ? "check your account-link status" : "did not respond in time");
    expect(h.sends[1].text).not.toContain("ask for a new private link");
    expect(h.logs().find((r) => r.stage === "verification.result")).toMatchObject({ outcome: committed ? "unknown" : "unavailable" });
    expect(JSON.stringify(h.logs())).not.toContain("SECRET");
  });
  it.each(["+15555550100", "15555550100@s.whatsapp.net", sender, "15555550101@s.whatsapp.net"])("completes private verification with a host-shaped conversation and sends one explicit acknowledgement (%s)", async (nativeConversation) => {
    const h = await fixture(true); register(h.api);
    const { event, context, code } = await prepareVerification(h);
    expect(await h.dispatch(event, { ...context, conversationId: nativeConversation })).toEqual({ handled: true });
    expect(resolveServiceActor(await h.f.context({ sender: canonicalPhone(sender)!, conversation: group })).actorUserId).toBe(h.f.userA);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({ to: canonicalPhone(sender), accountId: "account-A", text: "Your Plex account is linked." });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(1);
    expect(db.select().from(schema.mcpLinkChallenges).get()).toMatchObject({ completionCodeHash: null, consumedAt: expect.any(Date) });
    expect(h.logs().find((r) => r.stage === "verification.reply_delivered")).toMatchObject({ outcome: "linked" });
    expect(h.logs().find((r) => r.operation === "link_complete" && r.stage === "operation.completed")).toMatchObject({ outcome: "linked", acknowledgementConfirmed: true });
    for (const secret of [code, sender, "15555550100@s.whatsapp.net", h.f.credential.token, h.f.privateKeyPem]) expect(JSON.stringify(h.logs())).not.toContain(secret);
    // The receiving-bot exception is not available to model-created tools.
    expect(h.create(toolContext({ nativeChannelId: "+15555550100" }))).toBeNull();
  });
  it.each([false, true])("does not rely on automatic handled-text delivery and avoids duplicate replies (suppressed=%s)", async (suppressed) => {
    const h = await fixture(); register(h.api); const { event, context } = await prepareVerification(h);
    const automaticReply = vi.fn();
    const result = await h.dispatch(event, context);
    // Mirror the pinned host branch: only result.text can be automatically sent.
    if (result?.handled && result.text && !suppressed) automaticReply(result.text);
    expect(automaticReply).not.toHaveBeenCalled();
    expect(h.sends.filter((send) => send.text === "Your Plex account is linked.")).toHaveLength(1);
  });
  it.each([
    [undefined, "actor_conversation_unsupported"], ["999@lid", "actor_conversation_unsupported"],
    ["session:private:guessed", "actor_conversation_unsupported"], [group, "verification_conversation_not_private"],
    ["+15555550999", "actor_conversation_sender_mismatch"],
  ])("rejects an unsupported or unrelated private conversation without verifying or sending (%s)", async (nativeConversation, reason) => {
    const h = await fixture(true); register(h.api); const { event, context } = await prepareVerification(h);
    vi.mocked(fetch).mockClear(); vi.mocked(h.outbound.sendText!).mockClear();
    expect(await h.dispatch(event, { ...context, conversationId: nativeConversation })).toMatchObject({ handled: true });
    expect(fetch).not.toHaveBeenCalled(); expect(h.outbound.sendText).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(h.logs().find((r) => r.stage === "inbound.actor_rejected" && r.reason === reason)).toBeDefined();
  });
  it.each(["self", "account", "other-account-recipient"])("retains private sender/account isolation (%s)", async (mode) => {
    const h = await fixture(true);
    h.api.pluginConfig = { ...h.api.pluginConfig, accounts: { "account-A": "+15555550100", "account-B": "+15555550200" } }; register(h.api);
    const { event, context } = await prepareVerification(h); vi.mocked(fetch).mockClear();
    const result = await h.dispatch(mode === "self" ? { ...event, senderId: "+15555550100" } : event,
      mode === "self" ? { ...context, senderId: "+15555550100" } : mode === "account" ? { ...context, accountId: "unknown" } : { ...context, conversationId: "+15555550200" });
    expect(result).toMatchObject({ handled: true }); expect(fetch).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(1);
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(h.logs().find((r) => r.stage === "inbound.actor_rejected")).toMatchObject({ reason: mode === "self" ? "actor_self_sender" : mode === "account" ? "actor_account_unconfigured" : "actor_conversation_sender_mismatch" });
  });
  it("does not let a forwarded verification code bind a different admitted sender", async () => {
    const h = await fixture(true); register(h.api); const { event, context } = await prepareVerification(h);
    const other = "+15555550102";
    expect(await h.dispatch({ ...event, senderId: other }, { ...context, senderId: other })).toEqual({ handled: true });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(h.sends.at(-1)).toMatchObject({ to: canonicalPhone(other), text: "Account linking could not be completed. Please ask for a new private link." });
    expect(h.logs().find((r) => r.stage === "operation.completed" && r.operation === "link_complete")).toMatchObject({ outcome: "failed", acknowledgementConfirmed: true });
  });
  it("privately acknowledges an expired verification without creating a binding or replacement challenge", async () => {
    const h = await fixture(true); register(h.api); const { event, context } = await prepareVerification(h);
    vi.setSystemTime(new Date(Date.now() + 300_001));
    expect(await h.dispatch({ ...event, timestamp: Date.now() }, context)).toEqual({ handled: true });
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({ to: canonicalPhone(sender), text: "Account linking could not be completed. Please ask for a new private link." });
    expect(h.logs().find((r) => r.stage === "verification.reply_delivered")).toMatchObject({ outcome: "failed" });
  });
  it.each(["throw-after-send", "wrong-receipt", "closed-before-send"])("keeps the committed binding and never retries an unconfirmed acknowledgement (%s)", async (mode) => {
    const h = await fixture(true); register(h.api); const { event, context } = await prepareVerification(h);
    h.outbound.sendText = vi.fn(async (params) => {
      await params.onPlatformSendDispatch(); h.sends.push(params);
      if (mode === "throw-after-send") throw new Error(params.text);
      return { channel: "whatsapp", messageId: "ack-receipt", toJid: group };
    });
    if (mode === "closed-before-send") h.api.runtime.channel.outbound.loadAdapter = async () => { h.lifecycle.abort(); return h.outbound; };
    expect(await h.dispatch(event, context)).toEqual({ handled: true });
    expect(resolveServiceActor(await h.f.context({ sender: canonicalPhone(sender)!, conversation: group })).actorUserId).toBe(h.f.userA);
    expect(h.outbound.sendText).toHaveBeenCalledTimes(mode === "closed-before-send" ? 0 : 1);
    expect(h.sends).toHaveLength(mode === "closed-before-send" ? 1 : 2);
    expect(h.logs().find((r) => r.stage === "verification.reply_unconfirmed")).toBeDefined();
    expect(h.logs().find((r) => r.stage === "operation.completed" && r.operation === "link_complete")).toMatchObject({ outcome: "linked", acknowledgementConfirmed: false });
  });
  it("traces linking end-to-end in debug mode without logging URLs, credentials, codes, message IDs or participant identity", async () => {
    const h = await fixture(true); register(h.api);
    expect((await h.create()!.execute("debug", {})).details.status).toBe("private_link_sent");
    const stages = h.logs().map((r) => r.stage);
    for (const stage of ["registration.ready", "factory.link_admitted", "credentials.legacy_file", "connector.signing_key", "mcp.connect", "mcp.http.sign", "mcp.http.response", "mcp.tool_result", "link.delivery_validate", "outbound.private_adapter", "outbound.private_resolve", "outbound.private_dispatch", "outbound.private_receipt", "mcp.close", "operation.completed"]) expect(stages).toContain(stage);
    const invocation = h.logs().filter((r) => r.operation === "link_start");
    expect(new Set(invocation.map((r) => r.traceId)).size).toBe(1);
    expect(invocation.find((r) => r.stage === "mcp.http.response")).toMatchObject({ httpStatus: 200 });
    const url = h.sends[0].text.split(" ").at(-1)!;
    const code = prepareAccountLink(new URL(url).hash.slice(7), h.f.sessionA, h.f.userA).completionCode;
    await h.dispatch({ content: `Link account ${code}`, channel: "whatsapp", senderId: sender, messageId: "secret-inbound-id", timestamp: Date.now(), isGroup: false },
      { channelId: "whatsapp", accountId: "account-A", conversationId: sender, senderId: sender, messageId: "secret-inbound-id" });
    const raw = JSON.stringify(h.logs());
    for (const value of [url, code, new URL(url).hash.slice(7), h.f.credential.token, h.f.privateKeyPem, sender, canonicalPhone(sender)!, group, "account-A", "provider-message", "secret-inbound-id", "Link account", "Bearer ", "Thinkarr-Delegation"]) expect(raw).not.toContain(value);
    expect(h.logs().find((r) => r.operation === "link_complete" && r.stage === "operation.completed")).toMatchObject({ outcome: "linked" });
  });
  it("logs actionable failure stages and reason codes with debug disabled", async () => {
    const h = await fixture(); h.outbound.resolveTarget = () => ({ ok: true, to: group }); register(h.api);
    expect((await h.create()!.execute("failed", {})).details.status).toBe("failed");
    expect(h.logs().some((r) => r.level === "debug")).toBe(false);
    expect(h.logs().find((r) => r.stage === "outbound.private_resolve")).toMatchObject({ level: "error", reason: "private_target_mismatch" });
    expect(h.logs().find((r) => r.stage === "operation.completed")).toMatchObject({ outcome: "failed" });
  });
  it("turns detailed logging off when debug=false is applied to a replacement registration", async () => {
    const h = await fixture(true); register(h.api);
    expect((await h.create()!.execute("debug-on", {})).details.status).toBe("private_link_sent");
    expect(h.logs().some((r) => r.level === "debug")).toBe(true);
    h.logger.info.mockClear(); h.logger.warn.mockClear(); h.logger.error.mockClear();
    h.api.pluginConfig = { ...h.api.pluginConfig, debug: false }; register(h.api);
    expect((await h.create()!.execute("debug-off", {})).details.status).toBe("private_link_sent");
    expect(h.logs().some((r) => r.level === "debug")).toBe(false);
    expect(h.logs().find((r) => r.stage === "registration.ready")).toMatchObject({ debugEnabled: false });
    expect(h.logs().find((r) => r.stage === "operation.completed")).toMatchObject({ outcome: "private_link_sent" });
  });
  it("distinguishes missing SDK imports from signing-key parsing and reports neither raw exception", async () => {
    const h = await fixture(true); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, debug: true, connection: { ...connection,
      bearer: { source: "store", provider: "default", id: "SECRET_REF_TOKEN" }, privateKeyPem: { source: "store", provider: "default", id: "SECRET_REF_KEY" },
    } };
    vi.mocked(loadPreparedSecretReader).mockRejectedValue(Object.assign(new Error(`SECRET ${connection.privateKeyPem}`), { code: "ERR_MODULE_NOT_FOUND" }));
    register(h.api); expect((await h.create()!.execute("sdk", {})).details.status).toBe("failed");
    expect(h.logs().find((r) => r.stage === "credentials.load" && r.level === "error")).toMatchObject({ errorCode: "ERR_MODULE_NOT_FOUND" });
    const other = h;
    other.api.pluginConfig = { credentialsFile: h.credentialsFile, accounts: { "account-A": "+15555550100" }, debug: true };
    await writeFile(other.credentialsFile, JSON.stringify({ ...connection, privateKeyPem: "SECRET_MALFORMED_PRIVATE_KEY" }), { mode: 0o600 });
    register(other.api); expect((await other.create()!.execute("key", {})).details.status).toBe("failed");
    expect(other.logs().find((r) => r.stage === "connector.signing_key" && r.level === "error")).toBeDefined();
    for (const text of [JSON.stringify(h.logs()), JSON.stringify(other.logs())]) {
      expect(text).not.toContain("SECRET"); expect(text).not.toContain(connection.privateKeyPem); expect(text).not.toContain(connection.bearer);
    }
  });
  it("keeps delivery working if the host logger fails", async () => {
    const h = await fixture(true); const fail = () => { throw new Error("LOGGER SECRET"); };
    h.api.logger = { info: fail, warn: fail, error: fail }; register(h.api);
    expect((await h.create()!.execute("logger-failed", {})).details.status).toBe("private_link_sent"); expect(h.sends).toHaveLength(1);
  });
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
    expect(validate({ ...source, debug: true })).toBe(true);
    expect(validate({ ...source, debug: false })).toBe(true);
    expect(validate({ ...source, debug: "true" })).toBe(false);
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
  it("registers source refs without accessing secrets, then uses the admitted host reader for a real private link", async () => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    const read = vi.fn((_plugin: string, path: string) => ({ value: path === "connection.bearer" ? connection.bearer : connection.privateKeyPem, revision: 1 }));
    vi.mocked(loadPreparedSecretReader).mockResolvedValue(read);
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, connection: { ...connection,
      bearer: { source: "store", provider: "default", id: "PROTECTED_TOKEN" },
      privateKeyPem: { source: "store", provider: "default", id: "PROTECTED_KEY" },
    } };
    await rm(h.credentialsFile); register(h.api);
    expect(loadPreparedSecretReader).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(h.create(toolContext({ requesterSenderId: undefined }))).toBeNull(); expect(read).not.toHaveBeenCalled();
    const result = await h.create()!.execute("native-refs", {});
    expect(result.details.status).toBe("private_link_sent");
    expect(read.mock.calls.every(([plugin, path]) => plugin === "thinkarr" && ["connection.bearer", "connection.privateKeyPem"].includes(path))).toBe(true);
    const code = prepareAccountLink(new URL(h.sends[0].text.split(" ").at(-1)!).hash.slice(7), h.f.sessionA, h.f.userA).completionCode;
    expect(await h.dispatch({ content: `Link account ${code}`, channel: "whatsapp", senderId: sender,
      messageId: "native-verification", timestamp: Date.now(), isGroup: false,
    }, { channelId: "whatsapp", accountId: "account-A", conversationId: sender, senderId: sender, messageId: "native-verification" }))
      .toEqual({ handled: true });
    expect(JSON.stringify(result)).not.toContain(connection.bearer); expect(JSON.stringify(result)).not.toContain(connection.privateKeyPem);
  });
  it.each(["unavailable", "mismatched-revisions", "malformed-value", "reader-denied"])("fails closed for prepared secrets: %s", async (mode) => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, connection: { ...connection,
      bearer: { source: "store", provider: "default", id: "PROTECTED_TOKEN" },
      privateKeyPem: { source: "store", provider: "default", id: "PROTECTED_KEY" },
    } };
    if (mode !== "reader-denied") vi.mocked(loadPreparedSecretReader).mockResolvedValue((_plugin, path) => ({
      value: mode === "unavailable" ? undefined : mode === "malformed-value" ? "invalid" : path === "connection.bearer" ? connection.bearer : connection.privateKeyPem,
      revision: mode === "mismatched-revisions" && path === "connection.privateKeyPem" ? 2 : 1,
    }));
    register(h.api);
    expect((await h.create()!.execute("denied", {})).details.status).toBe("failed");
    expect(fetch).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(0);
    if (mode === "unavailable") {
      expect(h.logs().find((r) => r.stage === "secrets.prepared_status")).toMatchObject({ level: "error", bearerAvailable: false, keyAvailable: false });
      expect(h.logs().find((r) => r.stage === "credentials.load" && r.level === "error")).toMatchObject({ reason: "prepared_bearer_unavailable" });
    }
  });
  it.each(["revision", "unavailable"])("fences a native secret %s change before private delivery", async (mode) => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    let changed = false;
    h.api.pluginConfig = { accounts: { "account-A": "+15555550100" }, connection: { ...connection,
      bearer: { source: "store", provider: "default", id: "PROTECTED_TOKEN" },
      privateKeyPem: { source: "store", provider: "default", id: "PROTECTED_KEY" },
    } };
    vi.mocked(loadPreparedSecretReader).mockResolvedValue((_plugin, path) => ({
      value: changed && mode === "unavailable" ? undefined : path === "connection.bearer" ? connection.bearer : connection.privateKeyPem,
      revision: changed && mode === "revision" ? 2 : 1,
    }));
    h.api.runtime.channel.outbound.loadAdapter = async () => { changed = true; return h.outbound; };
    register(h.api);
    expect((await h.create()!.execute("revoked", {})).details.status).toBe("failed"); expect(h.sends).toHaveLength(0);
  });
  it("identifies malformed runtime secret types/formats without logging values, reference IDs or arbitrary keys", async () => {
    const h = await fixture(); const connection = JSON.parse(await readFile(h.credentialsFile, "utf8"));
    const hidden = "SENSITIVE_VALUE_MUST_NOT_APPEAR";
    h.api.pluginConfig = { accounts: { [hidden]: hidden }, connection: { ...connection,
      bearer: hidden, privateKeyPem: [hidden], [hidden]: hidden,
    }, [hidden]: hidden };
    let error: Error | undefined;
    try { register(h.api); } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain("connection.bearer: invalid_format (received string)");
    expect(error?.message).toContain("connection.privateKeyPem: invalid_type (received array)");
    expect(error?.message).toContain("accounts.*: invalid_format");
    expect(error?.message).toContain("unrecognized_keys");
    for (const value of [hidden, connection.bearer, connection.privateKeyPem]) expect(String(error)).not.toContain(value);
    expect(fetch).not.toHaveBeenCalled(); expect(h.api.registerTool).not.toHaveBeenCalled(); expect(h.api.on).not.toHaveBeenCalled();
  });
  it("registers supported factory/hook, sends only to the sender privately and completes the real backend link", async () => {
    const h = await fixture(); register(h.api);
    expect(h.api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ contextVersion: 2 }), { names: ["thinkarr_account_link"], optional: true });
    expect(h.api.on).toHaveBeenCalledWith("before_dispatch", expect.any(Function), { timeoutMs: 60_000 });
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
    expect(completed).toEqual({ handled: true });
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({ to: canonicalPhone(sender), text: "Your Plex account is linked." });
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
    expect(result.details).toEqual({ status: ["missing-receipt", "throw-after-send"].includes(mode) ? "private_delivery_unconfirmed" : "failed" });
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
