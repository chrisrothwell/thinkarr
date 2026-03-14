import { describe, it, expect, afterEach } from "vitest";

/**
 * Tests that log timestamps respect the TZ environment variable.
 *
 * Winston's default timestamp() uses Date.toISOString() which is always UTC.
 * Our custom format uses Date.toLocaleString('sv') which uses local time,
 * and Node.js derives local time from the TZ env var.
 */

const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTZ;
  }
});

describe("log timestamp format", () => {
  it("produces YYYY-MM-DD HH:MM:SS format", () => {
    const result = new Date().toLocaleString("sv");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("reflects TZ=UTC — timestamp matches UTC time", () => {
    process.env.TZ = "UTC";
    const now = new Date();
    const local = now.toLocaleString("sv");
    const utc = now.toISOString().slice(0, 19).replace("T", " ");
    expect(local).toBe(utc);
  });

  it("reflects TZ=America/New_York — timestamp differs from UTC in winter", () => {
    process.env.TZ = "America/New_York";
    // 2024-01-15 15:00:00 UTC = 2024-01-15 10:00:00 EST (UTC-5)
    const date = new Date("2024-01-15T15:00:00.000Z");
    const local = date.toLocaleString("sv");
    expect(local).toBe("2024-01-15 10:00:00");
  });

  it("reflects TZ=Europe/London — timestamp matches UTC in winter (no offset)", () => {
    process.env.TZ = "Europe/London";
    // London is UTC+0 in January
    const date = new Date("2024-01-15T15:00:00.000Z");
    const local = date.toLocaleString("sv");
    expect(local).toBe("2024-01-15 15:00:00");
  });

  it("reflects TZ=Asia/Tokyo — timestamp is UTC+9", () => {
    process.env.TZ = "Asia/Tokyo";
    // 2024-01-15 15:00:00 UTC = 2024-01-16 00:00:00 JST (UTC+9)
    const date = new Date("2024-01-15T15:00:00.000Z");
    const local = date.toLocaleString("sv");
    expect(local).toBe("2024-01-16 00:00:00");
  });
});
