import { describe, it, expect, afterEach } from "vitest";
import { formatLocalTimestamp } from "@/lib/logger";

/**
 * Tests that log timestamps respect the TZ environment variable and always
 * produce zero-padded YYYY-MM-DD HH:MM:SS output regardless of ICU/CLDR version.
 */

const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTZ;
  }
});

describe("formatLocalTimestamp", () => {
  it("produces zero-padded YYYY-MM-DD HH:MM:SS format", () => {
    // Use a date with single-digit month and day to verify zero-padding
    const date = new Date("2024-01-05T08:03:07.000Z");
    process.env.TZ = "UTC";
    expect(formatLocalTimestamp(date)).toBe("2024-01-05 08:03:07");
  });

  it("reflects TZ=UTC — timestamp matches UTC time", () => {
    process.env.TZ = "UTC";
    const date = new Date("2024-06-15T15:30:45.000Z");
    expect(formatLocalTimestamp(date)).toBe("2024-06-15 15:30:45");
  });

  it("reflects TZ=America/New_York — UTC-5 offset in winter", () => {
    process.env.TZ = "America/New_York";
    // 2024-01-15 15:00:00 UTC = 2024-01-15 10:00:00 EST (UTC-5)
    const date = new Date("2024-01-15T15:00:00.000Z");
    expect(formatLocalTimestamp(date)).toBe("2024-01-15 10:00:00");
  });

  it("reflects TZ=Europe/London — UTC+0 in winter", () => {
    process.env.TZ = "Europe/London";
    const date = new Date("2024-01-15T15:00:00.000Z");
    expect(formatLocalTimestamp(date)).toBe("2024-01-15 15:00:00");
  });

  it("reflects TZ=Asia/Tokyo — UTC+9", () => {
    process.env.TZ = "Asia/Tokyo";
    // 2024-01-15 15:00:00 UTC = 2024-01-16 00:00:00 JST
    const date = new Date("2024-01-15T15:00:00.000Z");
    expect(formatLocalTimestamp(date)).toBe("2024-01-16 00:00:00");
  });
});
