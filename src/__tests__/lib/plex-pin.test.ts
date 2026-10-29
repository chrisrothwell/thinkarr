import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(), schema: {} }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("Plex PIN check request boundary", () => {
  it.each(["123", "../resources", "//other.invalid", "123?next=https://other.invalid", {}, [], null, true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid PIN IDs before any fetch (%j)", async (pinId) => {
    const fetchRequest = vi.fn(); vi.stubGlobal("fetch", fetchRequest);
    const { checkPlexPin } = await import("@/lib/services/plex-auth");
    await expect(checkPlexPin(pinId as number)).rejects.toThrow("Invalid Plex PIN ID");
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it.each(["https://plex.tv", "http://127.0.0.1:32401"])("keeps numeric PIN checks on the configured API and rejects redirects (%s)", async (base) => {
    vi.stubEnv("PLEX_API_BASE", base);
    const fetchRequest = vi.fn().mockResolvedValueOnce(Response.json({ authToken: "claimed-token" }))
      .mockResolvedValueOnce(Response.json({ authToken: null }));
    vi.stubGlobal("fetch", fetchRequest);
    const { checkPlexPin } = await import("@/lib/services/plex-auth");
    expect(await checkPlexPin(123)).toBe("claimed-token");
    expect(await checkPlexPin(123)).toBeNull();
    expect(fetchRequest).toHaveBeenCalledWith(`${base}/api/v2/pins/123`, expect.objectContaining({ redirect: "error" }));
  });

  it("does not retry or hide a rejected redirect", async () => {
    const fetchRequest = vi.fn().mockRejectedValue(new TypeError("redirect rejected"));
    vi.stubGlobal("fetch", fetchRequest);
    const { checkPlexPin } = await import("@/lib/services/plex-auth");
    await expect(checkPlexPin(123)).rejects.toThrow("redirect rejected");
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });
});
