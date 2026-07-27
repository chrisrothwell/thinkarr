/**
 * Unit tests for GET /api/services/status — Plex 401 handling (#457).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({ user: { id: 1, isAdmin: true } })),
}));

const configValues: Record<string, string | null> = {};
vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => configValues[key] ?? null,
}));

import { GET } from "@/app/api/services/status/route";

describe("GET /api/services/status — Plex", () => {
  beforeEach(() => {
    for (const key of Object.keys(configValues)) delete configValues[key];
    configValues["plex.url"] = "http://plex.local:32400";
    configValues["plex.token"] = "stale-token";
  });

  it("reports a reconnect-oriented red status on Plex 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const res = await GET();
    const body = await res.json();
    const plex = body.data.services.find((s: { name: string }) => s.name === "Plex");

    expect(plex.status).toBe("red");
    expect(plex.message).toMatch(/reconnect/i);
  });

  it("reports amber with the raw status for other non-401 errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const res = await GET();
    const body = await res.json();
    const plex = body.data.services.find((s: { name: string }) => s.name === "Plex");

    expect(plex.status).toBe("amber");
    expect(plex.message).toBe("HTTP 500");
  });

  it("reports green when reachable with a valid token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const res = await GET();
    const body = await res.json();
    const plex = body.data.services.find((s: { name: string }) => s.name === "Plex");

    expect(plex.status).toBe("green");
  });
});
