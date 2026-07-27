/**
 * Unit tests for automatic Plex token refresh on 401 (#457).
 *
 * Plex's per-server access token (`plex.token`) can go stale independently of
 * a user's plex.tv account token (`users.plexToken`), which is long-lived and
 * doesn't require re-authenticating in a browser. `refreshPlexToken()`
 * reproduces the "click Discover Servers again" fix automatically by
 * re-running device discovery with an admin's account token and matching the
 * resource by `plex.clientIdentifier`. `plexFetch` (plex.ts) and `checkPlex`
 * (services/status/route.ts) both retry once through this path on a 401
 * before giving up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const configValues: Record<string, string | null> = {};
const setConfigSpy = vi.fn();

vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => configValues[key] ?? null,
  setConfig: (key: string, value: string, encrypted = false) => {
    setConfigSpy(key, value, encrypted);
    configValues[key] = value;
  },
}));

interface AdminRow {
  id: number;
  isAdmin: boolean;
  plexToken: string | null;
}

let adminRows: AdminRow[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => undefined,
          all: () => adminRows,
        }),
      }),
    }),
  }),
  schema: { users: { id: "id", isAdmin: "is_admin", plexToken: "plex_token" } },
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security/url-validation", () => ({ validateServiceUrl: () => ({ valid: true }) }));

const PLEX_SERVER_URL = "http://plex.local:32400";

function mockFetchSequence(handlers: Record<string, () => { status: number; body?: unknown }>) {
  return vi.fn().mockImplementation(async (url: string) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) {
        const { status, body } = handler();
        return { ok: status >= 200 && status < 300, status, json: async () => body ?? {} };
      }
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("refreshPlexToken + plexFetch retry — #457", () => {
  beforeEach(() => {
    vi.resetModules();
    setConfigSpy.mockClear();
    for (const key of Object.keys(configValues)) delete configValues[key];
    configValues["plex.url"] = PLEX_SERVER_URL;
    configValues["plex.token"] = "stale-token";
    adminRows = [];
  });

  it("retries and succeeds after refreshing a stale token via re-discovery", async () => {
    configValues["plex.clientIdentifier"] = "server-abc";
    adminRows = [{ id: 1, isAdmin: true, plexToken: "admin-account-token" }];

    let plexCallCount = 0;
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        "https://plex.tv/api/v2/resources": () => ({
          status: 200,
          body: [
            {
              provides: "server",
              name: "Home Server",
              clientIdentifier: "server-abc",
              accessToken: "fresh-token",
              owned: true,
              connection: [],
            },
          ],
        }),
        [PLEX_SERVER_URL]: () => {
          plexCallCount++;
          if (plexCallCount === 1) return { status: 401 };
          return { status: 200, body: { MediaContainer: { Hub: [] } } };
        },
      }),
    );

    const { searchLibrary } = await import("@/lib/services/plex");
    const result = await searchLibrary("matrix");

    expect(result.results).toEqual([]);
    expect(plexCallCount).toBe(2);
    expect(setConfigSpy).toHaveBeenCalledWith("plex.token", "fresh-token", true);
    expect(configValues["plex.token"]).toBe("fresh-token");
  });

  it("throws the reconnect error when no admin's account has access to a matching server", async () => {
    configValues["plex.clientIdentifier"] = "server-abc";
    adminRows = [{ id: 1, isAdmin: true, plexToken: "admin-account-token" }];

    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        "https://plex.tv/api/v2/resources": () => ({ status: 200, body: [] }),
        [PLEX_SERVER_URL]: () => ({ status: 401 }),
      }),
    );

    const { searchLibrary } = await import("@/lib/services/plex");
    await expect(searchLibrary("matrix")).rejects.toThrow(/reconnect/i);
    expect(setConfigSpy).not.toHaveBeenCalled();
  });

  it("skips discovery entirely when no clientIdentifier is on record", async () => {
    // plex.clientIdentifier intentionally left unset
    adminRows = [{ id: 1, isAdmin: true, plexToken: "admin-account-token" }];

    const fetchMock = mockFetchSequence({
      [PLEX_SERVER_URL]: () => ({ status: 401 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchLibrary } = await import("@/lib/services/plex");
    await expect(searchLibrary("matrix")).rejects.toThrow(/reconnect/i);
    // Only the single failed request to the Plex server — no plex.tv discovery call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
