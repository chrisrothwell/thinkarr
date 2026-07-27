import { describe, it, expect } from "vitest";
import { selectPlexConnectionUrl } from "@/lib/plex-device-select";

describe("selectPlexConnectionUrl", () => {
  it("returns an error when the device has no connections (#457)", () => {
    const result = selectPlexConnectionUrl({ name: "Offline Server", connections: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Offline Server/);
      expect(result.error).toMatch(/no reachable connection/i);
    }
  });

  it("prefers a local http connection", () => {
    const result = selectPlexConnectionUrl({
      name: "Server",
      connections: [
        { protocol: "https", address: "1.2.3.4", port: 32400, local: false },
        { protocol: "http", address: "192.168.1.20", port: 32400, local: true },
      ],
    });
    expect(result).toEqual({ ok: true, url: "http://192.168.1.20:32400" });
  });

  it("falls back to any local connection when no local http connection exists", () => {
    const result = selectPlexConnectionUrl({
      name: "Server",
      connections: [
        { protocol: "https", address: "1.2.3.4", port: 32400, local: false },
        { protocol: "https", address: "192.168.1.20", port: 32400, local: true },
      ],
    });
    expect(result).toEqual({ ok: true, url: "https://192.168.1.20:32400" });
  });

  it("falls back to the first connection when none are local", () => {
    const result = selectPlexConnectionUrl({
      name: "Server",
      connections: [{ protocol: "https", address: "1.2.3.4", port: 32400, local: false }],
    });
    expect(result).toEqual({ ok: true, url: "https://1.2.3.4:32400" });
  });
});
