/** The unsigned text-channel adapter is retired, including its link/token APIs. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(), schema: {} }));
vi.mock("@/lib/config", () => ({ getConfig: vi.fn(() => "test-bearer"), setConfig: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/services/plex-auth", () => ({ checkPlexPin: vi.fn(), getPlexUser: vi.fn() }));
vi.mock("@/lib/services/overseerr", () => ({ requestMovie: vi.fn(), requestTv: vi.fn() }));
vi.mock("@/lib/tools/pending-basket", () => ({ createBasket: vi.fn(), resolveBasket: vi.fn() }));

import { POST } from "@/app/api/mcp/route";
import * as globalToken from "@/app/api/settings/mcp-token/route";
import * as userToken from "@/app/api/settings/mcp-token/user/[userId]/route";
import * as unsignedLink from "@/app/api/mcp/link/route";
import { getDb } from "@/lib/db";
import { getConfig, setConfig } from "@/lib/config";
import { getSession } from "@/lib/auth/session";
import { checkPlexPin, getPlexUser } from "@/lib/services/plex-auth";
import { requestMovie, requestTv } from "@/lib/services/overseerr";
import { createBasket, resolveBasket } from "@/lib/tools/pending-basket";

describe("legacy text-mode access is removed", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["plex_get_on_deck", "display_titles", "confirm_request", "overseerr_request_movie", "overseerr_request_tv"])(
    "rejects unsigned %s without creating links, baskets or media requests", async (tool) => {
      const response = await POST(new Request("http://localhost/api/mcp?mode=text", {
        method: "POST", headers: {
          Authorization: "Bearer test-bearer", "X-Channel-Type": "whatsapp", "X-Channel-User-Id": "forged-sender",
        }, body: JSON.stringify({ tool, arguments: { pendingKey: "old-basket", selection: 1 } }),
      }));
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.registrationUrl).toBeUndefined();
      expect(body.result).toBeUndefined();
      for (const fn of [getDb, getConfig, requestMovie, requestTv, createBasket, resolveBasket]) expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["global token GET", globalToken.GET], ["global token POST", globalToken.POST],
    ["user token GET", userToken.GET], ["user token POST", userToken.POST],
    ["unsigned link GET", unsignedLink.GET], ["unsigned link POST", unsignedLink.POST],
  ] as const)("retires %s without reading or issuing credentials or changing identities", async (_name, handler) => {
    const response = await handler();
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: false, error: expect.stringContaining("registered service integration") });
    for (const fn of [getDb, getConfig, setConfig, getSession, checkPlexPin, getPlexUser]) expect(fn).not.toHaveBeenCalled();
  });
});
