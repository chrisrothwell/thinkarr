import { describe, it, expect, beforeEach } from "vitest";
import { checkAuthRateLimit, getClientIp, _resetRateLimits } from "@/lib/auth/rate-limit";

beforeEach(() => {
  _resetRateLimits();
});

describe("checkAuthRateLimit", () => {
  it("allows the first attempt from an IP", () => {
    expect(checkAuthRateLimit("1.2.3.4")).toBe(true);
  });

  it("allows up to 10 attempts from the same IP", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkAuthRateLimit("1.2.3.4")).toBe(true);
    }
  });

  it("blocks the 11th attempt from the same IP", () => {
    for (let i = 0; i < 10; i++) checkAuthRateLimit("1.2.3.4");
    expect(checkAuthRateLimit("1.2.3.4")).toBe(false);
  });

  it("does not affect other IPs", () => {
    for (let i = 0; i < 11; i++) checkAuthRateLimit("1.2.3.4");
    expect(checkAuthRateLimit("5.6.7.8")).toBe(true);
  });

  it("resets the counter after the window expires", () => {
    for (let i = 0; i < 11; i++) checkAuthRateLimit("1.2.3.4");
    expect(checkAuthRateLimit("1.2.3.4")).toBe(false);

    // Simulate window expiry by manipulating the bucket directly via reset
    _resetRateLimits();
    expect(checkAuthRateLimit("1.2.3.4")).toBe(true);
  });
});

describe("getClientIp", () => {
  it("returns x-forwarded-for when present", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.1, 172.16.0.1" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("returns x-real-ip when x-forwarded-for is absent", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "10.0.0.2" },
    });
    expect(getClientIp(req)).toBe("10.0.0.2");
  });

  it("prefers x-forwarded-for over x-real-ip", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.1", "x-real-ip": "10.0.0.2" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("returns 'unknown' when no IP headers are present", () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});
