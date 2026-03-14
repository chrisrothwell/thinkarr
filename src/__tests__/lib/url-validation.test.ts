import { describe, it, expect } from "vitest";
import { validateServiceUrl } from "@/lib/security/url-validation";

describe("validateServiceUrl", () => {
  describe("valid URLs", () => {
    it("accepts a plain HTTP LAN address (Plex/Sonarr/etc. use case)", () => {
      expect(validateServiceUrl("http://192.168.1.100:32400")).toEqual({ valid: true });
    });

    it("accepts a plain HTTP 10.x address", () => {
      expect(validateServiceUrl("http://10.0.0.1:8989")).toEqual({ valid: true });
    });

    it("accepts localhost (Ollama use case)", () => {
      expect(validateServiceUrl("http://localhost:11434")).toEqual({ valid: true });
    });

    it("accepts 127.0.0.1 (LM Studio use case)", () => {
      expect(validateServiceUrl("http://127.0.0.1:1234")).toEqual({ valid: true });
    });

    it("accepts HTTPS URLs", () => {
      expect(validateServiceUrl("https://my-plex.example.com")).toEqual({ valid: true });
    });

    it("accepts URLs with paths", () => {
      expect(validateServiceUrl("http://192.168.0.10:8989/sonarr")).toEqual({ valid: true });
    });
  });

  describe("blocked schemes", () => {
    it("rejects file:// URLs", () => {
      const result = validateServiceUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/http/i);
    });

    it("rejects ftp:// URLs", () => {
      const result = validateServiceUrl("ftp://example.com");
      expect(result.valid).toBe(false);
    });

    it("rejects data: URLs", () => {
      const result = validateServiceUrl("data:text/html,<h1>hi</h1>");
      expect(result.valid).toBe(false);
    });
  });

  describe("blocked hosts — cloud metadata", () => {
    it("rejects 169.254.169.254 (AWS IMDSv1 / GCP / Azure metadata)", () => {
      const result = validateServiceUrl("http://169.254.169.254/latest/meta-data");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not permitted/i);
    });

    it("rejects any 169.254.x.x address", () => {
      expect(validateServiceUrl("http://169.254.0.1").valid).toBe(false);
      expect(validateServiceUrl("http://169.254.255.255").valid).toBe(false);
    });

    it("rejects IPv6 link-local fe80::", () => {
      expect(validateServiceUrl("http://[fe80::1]").valid).toBe(false);
    });

    it("rejects 0.0.0.0", () => {
      expect(validateServiceUrl("http://0.0.0.0").valid).toBe(false);
    });
  });

  describe("invalid format", () => {
    it("rejects empty string", () => {
      const result = validateServiceUrl("");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/invalid url/i);
    });

    it("rejects bare hostname with no scheme", () => {
      const result = validateServiceUrl("plex.local:32400");
      expect(result.valid).toBe(false);
    });

    it("rejects random string", () => {
      expect(validateServiceUrl("not-a-url").valid).toBe(false);
    });
  });
});
