import { describe, expect, it } from "vitest";
import { privateAccountLinkUrl, privateLinkFragmentToken, publicLinkOriginSchema, whatsappBotNumberSchema, whatsappVerificationUrl } from "@/lib/mcp/link-handoff";

describe("private mobile linking addresses", () => {
  it("keeps challenge secrets out of the HTTP path/query and accepts only the generated fragment format", () => {
    const token = "a".repeat(64);
    const url = new URL(privateAccountLinkUrl("https://thinkarr.example.com/", token));
    expect(url.origin).toBe("https://thinkarr.example.com");
    expect(url.pathname).toBe("/mcp/connect");
    expect(url.search).toBe("");
    expect(privateLinkFragmentToken(url.hash)).toBe(token);
    for (const fragment of ["", `?token=${token}`, `#token=${token}&token=${token}`, "#token=short", `#token=${token.toUpperCase()}`]) expect(privateLinkFragmentToken(fragment)).toBeNull();
  });

  it.each([
    "http://192.168.1.20:3000", "javascript:alert(1)", "https://user:password@thinkarr.example.com",
    "https://thinkarr.example.com/path", "https://thinkarr.example.com?target=other", "https://thinkarr.example.com#secret",
  ])("rejects unsafe or non-origin administrator configuration %s", (value) => {
    expect(publicLinkOriginSchema.safeParse(value).success).toBe(false);
  });

  it.each(["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"])("permits explicit loopback development origin %s", (value) => {
    expect(publicLinkOriginSchema.parse(value)).toBe(value);
  });

  it("normalizes the configured bot number and prefills an explicit private message without auto-sending", () => {
    const code = "b".repeat(64);
    expect(whatsappBotNumberSchema.parse("+15555550100")).toBe("15555550100");
    const url = new URL(whatsappVerificationUrl("+15555550100", code));
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/15555550100");
    expect(url.searchParams.get("text")).toBe(`Link account ${code}`);
    expect(url.hash).toBe("");
    for (const number of ["01555550100", "https://evil.invalid", "15555550100?text=other", "+1 555 555 0100"]) expect(() => whatsappVerificationUrl(number, code)).toThrow();
  });
});
