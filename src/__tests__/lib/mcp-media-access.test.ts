import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
import { setConfig } from "@/lib/config";
import { completeAccountLink, initiateAccountLink, prepareAccountLink, resolveServiceActor, revokeAccountBinding } from "@/lib/mcp/account-linking";
import { createDelegatedMediaAccess, type RequestEligibilitySelection } from "@/lib/mcp/media-access";
import { revokeServiceCredential, revokeServiceKey } from "@/lib/mcp/service-principals";
import { logger } from "@/lib/logger";

beforeEach(() => {
  ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-21T01:00:00Z"));
  vi.stubEnv("PLEX_API_BASE", "https://plex.invalid"); vi.clearAllMocks();
  setConfig("plex.url", "http://plex.internal:32400"); setConfig("plex.clientIdentifier", "configured-server");
  setConfig("plex.token", "ADMIN-SERVER-TOKEN-NOT-ACTORITY");
  setConfig("overseerr.url", "http://seerr.internal:5055"); setConfig("overseerr.apiKey", "directory-key");
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  const f = await delegatedLinkFixture(db, adminId);
  db.update(schema.users).set({ plexId: "101", plexToken: "account-A" }).where(eq(schema.users.id, f.userA)).run();
  db.update(schema.users).set({ plexId: "202", plexToken: "account-B" }).where(eq(schema.users.id, f.userB)).run();
  async function bind(which: "A" | "B" = "A", conversation = "group-A") {
    const sender = `sender-${which}`;
    const origin = await f.context({ sender, conversation });
    const challenge = initiateAccountLink(origin);
    if (challenge.linked) throw new Error("Unexpected binding");
    const userId = which === "A" ? f.userA : f.userB;
    const code = prepareAccountLink(challenge.token, which === "A" ? f.sessionA : f.sessionB, userId).completionCode;
    completeAccountLink(await f.privateContext(code, { sender }), code);
    return f.context({ sender, conversation });
  }
  const context = await bind();
  type DirectoryUser = { id: number; plexId?: number | string | null; userType: number; [key: string]: unknown };
  const state = {
    users: [
      { id: 1, plexId: 999, userType: 1, plexUsername: "same-display-name" },
      { id: 7, plexId: 101, userType: 1, plexUsername: "renamed-actor", email: "private@example.invalid" },
    ] as DirectoryUser[],
    effective: { id: 7, plexId: 101, userType: 1, permissions: 32 },
    quotas: { movie: { used: 0, limit: 3, remaining: 3, restricted: false }, tv: { used: 0, limit: 3, remaining: 3, restricted: false } },
    resources: [{ clientIdentifier: "configured-server", provides: "server", accessToken: "restricted-server-A", connections: [{ uri: "http://169.254.169.254/never-follow" }] }],
    sections: { MediaContainer: { Directory: [{ key: "11", type: "movie", title: "actor-only-library" }, { key: "12", type: "show" }, { key: "13", type: "artist" }] } },
    accountId: 101,
    machineId: "configured-server",
    afterResponse: undefined as ((url: URL) => void) | undefined,
    transform: undefined as ((url: URL, value: unknown) => unknown) | undefined,
  };
  const fetchRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    expect(headers.get("X-Plex-Token")).not.toBe("ADMIN-SERVER-TOKEN-NOT-ACTORITY");
    let value: unknown;
    if (url.origin === "https://plex.invalid") {
      expect(headers.get("X-Plex-Token")).toBe("account-A");
      if (url.pathname === "/api/v2/user") value = { id: state.accountId, username: "renamed", email: "private@example.invalid", authToken: "never-return" };
      else if (url.pathname === "/api/v2/resources") value = state.resources;
      else throw new Error("Unexpected account path");
    } else if (url.origin === "http://plex.internal:32400") {
      expect(headers.get("X-Plex-Token")).toBe("restricted-server-A");
      if (url.pathname === "/identity") value = { MediaContainer: { machineIdentifier: state.machineId } };
      else if (url.pathname === "/library/sections") value = state.sections;
      else throw new Error("Unexpected Plex path");
    } else if (url.origin === "http://seerr.internal:5055") {
      expect(headers.get("X-Api-Key")).toBe("directory-key");
      if (url.pathname === "/api/v1/user") {
        expect(headers.get("X-Api-User")).toBeNull();
        const skip = Number(url.searchParams.get("skip"));
        value = { pageInfo: { page: skip / 100 + 1, pageSize: 100, pages: Math.ceil(state.users.length / 100), results: state.users.length }, results: state.users.slice(skip, skip + 100) };
      } else {
        expect(headers.get("X-Api-User")).toBe("7");
        if (url.pathname === "/api/v1/auth/me") value = state.effective;
        else if (url.pathname === "/api/v1/user/7/quota") value = state.quotas;
        else throw new Error("Unexpected Seerr path");
      }
    } else throw new Error("Unpinned destination");
    if (state.transform) value = state.transform(url, value);
    state.afterResponse?.(url);
    return Response.json(value);
  });
  vi.stubGlobal("fetch", fetchRequest);
  return { f, context, bind, state, fetchRequest, access: () => createDelegatedMediaAccess(context, "media_search") };
}

describe("delegated media downstream identity/preflight", () => {
  it("uses only the actor account and matching resource token for configured-server library visibility", async () => {
    const h = await fixture();
    const result = await h.access().visibleLibrarySections();
    expect(result).toEqual({ shared: true, sections: [{ key: "11", type: "movie" }, { key: "12", type: "show" }] });
    expect(h.fetchRequest).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toMatch(/token|account-A|restricted-server|actor-only-library|private@example/);
    expect(JSON.stringify(h.access())).toBe("{}");
  });

  it("maps Seerr by immutable Plex ID rather than matching display name and confirms the effective user", async () => {
    const h = await fixture();
    vi.mocked(logger.info).mockClear();
    expect(await h.access().requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
    expect(h.fetchRequest.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v2/user", "/api/v1/user", "/api/v1/auth/me", "/api/v1/user/7/quota"]);
    expect(logger.info).not.toHaveBeenCalled(); expect(logger.warn).not.toHaveBeenCalled(); expect(logger.error).not.toHaveBeenCalled();
  });

  it("isolates concurrent participants sharing a display name, including library tokens and Seerr authority", async () => {
    const h = await fixture();
    const contextB = await h.bind("B");
    h.state.users.push({ id: 8, plexId: 202, userType: 1, plexUsername: "same-display-name" });
    const original = h.fetchRequest.getMockImplementation()!;
    h.fetchRequest.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); const headers = new Headers(init?.headers);
      await Promise.resolve();
      if (headers.get("X-Plex-Token") === "account-B") {
        if (url.pathname === "/api/v2/user") return Response.json({ id: 202 });
        if (url.pathname === "/api/v2/resources") return Response.json([{ clientIdentifier: "configured-server", provides: "server", accessToken: "restricted-server-B" }]);
      }
      if (headers.get("X-Plex-Token") === "restricted-server-B") {
        if (url.pathname === "/identity") return Response.json({ MediaContainer: { machineIdentifier: "configured-server" } });
        if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: [{ key: "22", type: "movie" }] } });
      }
      if (headers.get("X-Api-User") === "8" && url.pathname === "/api/v1/auth/me") return Response.json({ id: 8, plexId: 202, userType: 1, permissions: 0 });
      return original(input, init);
    });
    const accessA = h.access(); const accessB = createDelegatedMediaAccess(contextB, "media_search");
    const [librariesA, librariesB, eligibilityA, eligibilityB] = await Promise.all([
      accessA.visibleLibrarySections(), accessB.visibleLibrarySections(),
      accessA.requestEligibility({ mediaType: "movie" }), accessB.requestEligibility({ mediaType: "movie" }),
    ]);
    expect(librariesA.sections.map((s) => s.key)).toEqual(["11", "12"]);
    expect(librariesB.sections.map((s) => s.key)).toEqual(["22"]);
    expect(eligibilityA).toEqual({ eligible: true }); expect(eligibilityB).toEqual({ eligible: false, reason: "permission" });
  });

  it("allows Seerr eligibility without current Plex shares and does not consult server-wide availability", async () => {
    const h = await fixture(); h.state.resources = [];
    const access = h.access();
    expect(await access.visibleLibrarySections()).toEqual({ shared: false, sections: [] });
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
    expect(h.fetchRequest.mock.calls.every(([url]) => !String(url).startsWith("http://plex.internal"))).toBe(true);
  });

  it("scans every stable directory page and rejects a later duplicate immutable identity", async () => {
    const h = await fixture();
    h.state.users = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, plexId: i === 6 ? 101 : 1000 + i, userType: 1 }));
    expect(await h.access().requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
    expect(h.fetchRequest.mock.calls.some(([url]) => String(url).endsWith("skip=100"))).toBe(true);
    h.state.users[100].plexId = 101;
    await expect(h.access().requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "AMBIGUOUS_SEERR_ACCOUNT" });
  });

  it("blocks absent or local Seerr identities without provisioning/falling back to administrator", async () => {
    const h = await fixture(); h.state.users = [h.state.users[0]];
    expect(await h.access().requestEligibility({ mediaType: "movie" })).toEqual({ eligible: false, reason: "seerr_account_required" });
    expect(h.fetchRequest).toHaveBeenCalledTimes(2);
    h.state.users.push({ id: 7, plexId: 101, userType: 2 });
    await expect(h.access().requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "AMBIGUOUS_SEERR_ACCOUNT" });
  });

  it.each(["id", "plexId", "userType"] as const)("rejects effective-user %s mismatch (including ignored X-Api-User)", async (field) => {
    const h = await fixture(); h.state.effective[field] = 1;
    if (field === "userType") h.state.effective.userType = 2;
    await expect(h.access().requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "EFFECTIVE_USER_MISMATCH" });
    expect(h.fetchRequest.mock.calls.some(([url]) => String(url).includes("/quota"))).toBe(false);
  });

  it("rechecks current downstream permissions without inheriting Thinkarr administrator authority or caching", async () => {
    const h = await fixture(); db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, h.f.userA)).run();
    const access = h.access();
    h.state.effective.permissions = 0;
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: false, reason: "permission" });
    h.state.effective.permissions = 262144;
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
    expect(await access.requestEligibility({ mediaType: "tv", seasons: [1] })).toEqual({ eligible: false, reason: "permission" });
    h.state.effective.permissions = 524288;
    expect(await access.requestEligibility({ mediaType: "tv", seasons: [1] })).toEqual({ eligible: true });
    h.state.effective.permissions = 2;
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
  });

  it("checks exact TV-season quota units, limited/unlimited quotas and invalid quota responses", async () => {
    const h = await fixture(); const access = h.access();
    h.state.quotas.tv.remaining = 1;
    expect(await access.requestEligibility({ mediaType: "tv", seasons: [1, 3] })).toEqual({ eligible: false, reason: "quota" });
    expect(await access.requestEligibility({ mediaType: "tv", seasons: [3] })).toEqual({ eligible: true });
    h.state.quotas.movie.restricted = true;
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: false, reason: "quota" });
    h.state.quotas.movie = { used: 99, limit: 0, remaining: 0, restricted: false };
    expect(await access.requestEligibility({ mediaType: "movie" })).toEqual({ eligible: true });
    h.state.quotas.tv.remaining = 999;
    await expect(access.requestEligibility({ mediaType: "tv", seasons: [1] })).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
  });

  it.each([
    { mediaType: "movie", userId: 1 }, { mediaType: "movie", seasons: [1] },
    { mediaType: "tv", seasons: [] }, { mediaType: "tv", seasons: [1, 1] }, { mediaType: "tv", seasons: [-1] },
  ])("rejects invalid/identity-selecting preflight input %j before contacting downstream", async (selection) => {
    const h = await fixture();
    await expect(h.access().requestEligibility(selection as RequestEligibilitySelection)).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    expect(h.fetchRequest).not.toHaveBeenCalled();
  });

  it.each(["credential", "key", "binding", "scope", "token", "config", "version", "expiry"])("rejects %s changes in flight and invalidates retained capabilities", async (target) => {
    const h = await fixture(); const access = h.access();
    const binding = resolveServiceActor(h.context);
    h.state.afterResponse = () => {
      h.state.afterResponse = undefined;
      if (target === "credential") revokeServiceCredential(h.f.principal.id, h.f.credential.id, adminId);
      if (target === "key") revokeServiceKey(h.f.principal.id, h.f.key.id, adminId);
      if (target === "binding") revokeAccountBinding(binding.bindingId, h.f.userA);
      if (target === "scope") db.update(schema.mcpServicePrincipals).set({ allowedOperations: "[]" }).where(eq(schema.mcpServicePrincipals.id, h.f.principal.id)).run();
      if (target === "token") db.update(schema.users).set({ plexToken: "new-token" }).where(eq(schema.users.id, h.f.userA)).run();
      if (target === "config") setConfig("overseerr.apiKey", "replaced-key");
      if (target === "version") db.update(schema.mcpActorBindings).set({ version: binding.bindingVersion + 1 }).where(eq(schema.mcpActorBindings.id, binding.bindingId)).run();
      if (target === "expiry") vi.setSystemTime(Date.now() + 66_000);
    };
    await expect(access.requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "ACTOR_UNAVAILABLE" });
    await expect(access.visibleLibrarySections()).rejects.toMatchObject({ code: "ACTOR_UNAVAILABLE" });
    expect(h.fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("denies wrong Plex identity, invalid resources, machine mismatches and unprovable library responses", async () => {
    const h = await fixture(); const access = h.access();
    h.state.accountId = 999;
    await expect(access.requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "PLEX_SIGN_IN_REQUIRED" });
    h.state.accountId = 101; h.state.machineId = "different-server";
    await expect(access.visibleLibrarySections()).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
    h.state.machineId = "configured-server";
    h.state.resources.push(h.state.resources[0]);
    await expect(access.visibleLibrarySections()).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
    h.state.resources.pop();
    h.state.transform = (url, value) => url.pathname === "/library/sections" ? { MediaContainer: {} } : value;
    await expect(access.visibleLibrarySections()).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
    h.state.transform = (url, value) => url.pathname === "/library/sections" ? { MediaContainer: { size: 0 } } : value;
    expect(await access.visibleLibrarySections()).toEqual({ shared: true, sections: [] });
  });

  it.each(["missing-field", "wrong-total", "wrong-page", "unstable-ids", "unbounded"])("rejects malformed directory pagination: %s", async (mode) => {
    const h = await fixture();
    h.state.transform = (url, value) => {
      if (url.pathname !== "/api/v1/user") return value;
      if (mode === "missing-field") return { results: h.state.users };
      return { pageInfo: { page: mode === "wrong-page" ? 2 : 1, pageSize: 100, pages: 1,
        results: mode === "wrong-total" ? 3 : mode === "unbounded" ? 10_001 : 2 },
      results: mode === "unstable-ids" ? [h.state.users[1], h.state.users[0]] : h.state.users };
    };
    await expect(h.access().requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
  });

  it.each([401, 403, 500, 307])("sanitizes downstream HTTP %s, forbids redirects and never falls back", async (status) => {
    const h = await fixture();
    h.fetchRequest.mockImplementation(async () => new Response("SECRET upstream account-A directory-key private@example.invalid", { status, headers: { Location: "https://attacker.invalid" } }));
    const promise = h.access().requestEligibility({ mediaType: "movie" });
    await expect(promise).rejects.toMatchObject({ code: [401, 403].includes(status) ? "PLEX_SIGN_IN_REQUIRED" : "DOWNSTREAM_UNAVAILABLE" });
    await expect(promise).rejects.toThrow("Delegated media access could not be verified.");
    expect(h.fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized/malformed bodies and cancelled work without exposing upstream data", async () => {
    const h = await fixture();
    const access = h.access();
    await expect(access.requestEligibility({ mediaType: "movie" }, AbortSignal.abort())).rejects.toMatchObject({ code: "DOWNSTREAM_UNAVAILABLE" });
    expect(h.fetchRequest).not.toHaveBeenCalled();
    h.fetchRequest.mockImplementation(async () => new Response("x".repeat(1_048_577)));
    await expect(access.requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
    h.fetchRequest.mockImplementation(async () => new Response("not-json"));
    await expect(access.requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "INVALID_DOWNSTREAM_RESPONSE" });
  });

  it.each(["http://169.254.169.254", "file:///tmp/key", "https://user:password@seerr.invalid", "https://seerr.invalid?key=secret"])("rejects unsafe configured service URL %s without sending credentials there", async (url) => {
    const h = await fixture(); setConfig("overseerr.url", url);
    await expect(h.access().requestEligibility({ mediaType: "movie" })).rejects.toMatchObject({ code: "SERVICE_NOT_CONFIGURED" });
    expect(h.fetchRequest).toHaveBeenCalledTimes(1);
    expect(String(h.fetchRequest.mock.calls[0][0])).toBe("https://plex.invalid/api/v2/user");
  });

  it("requires a current scoped binding, a verified media operation and the participant own token", async () => {
    const h = await fixture();
    expect(() => createDelegatedMediaAccess(h.context, "account_link_start" as "media_search")).toThrow();
    expect(() => createDelegatedMediaAccess({} as typeof h.context, "media_search")).toThrow();
    const other = await h.f.context({ conversation: "different-group" });
    expect(() => createDelegatedMediaAccess(other, "media_search")).toThrow();
    db.update(schema.users).set({ plexToken: null }).where(eq(schema.users.id, h.f.userA)).run();
    expect(() => h.access()).toThrow();
    expect(h.fetchRequest).not.toHaveBeenCalled();
  });
});
