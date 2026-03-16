import { describe, it, expect, beforeEach } from "vitest";
import { checkUserApiRateLimit, _resetApiRateLimits } from "@/lib/security/api-rate-limit";

beforeEach(() => {
  _resetApiRateLimits();
});

describe("checkUserApiRateLimit", () => {
  it("allows the first request from a user", () => {
    expect(checkUserApiRateLimit(1)).toBe(true);
  });

  it("allows up to 60 requests from the same user", () => {
    for (let i = 0; i < 60; i++) {
      expect(checkUserApiRateLimit(1)).toBe(true);
    }
  });

  it("blocks the 61st request from the same user", () => {
    for (let i = 0; i < 60; i++) checkUserApiRateLimit(1);
    expect(checkUserApiRateLimit(1)).toBe(false);
  });

  it("does not affect other users", () => {
    for (let i = 0; i < 61; i++) checkUserApiRateLimit(1);
    expect(checkUserApiRateLimit(2)).toBe(true);
  });

  it("resets the counter after the window expires", () => {
    for (let i = 0; i < 61; i++) checkUserApiRateLimit(1);
    expect(checkUserApiRateLimit(1)).toBe(false);

    _resetApiRateLimits();
    expect(checkUserApiRateLimit(1)).toBe(true);
  });
});
