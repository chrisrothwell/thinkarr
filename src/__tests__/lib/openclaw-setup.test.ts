import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionConnection } from "../../../connectors/openclaw/setup";

const service = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const code = `thk_setup_${service}.${"a".repeat(64)}`;
const bearer = `thk_svc_${credentialId}.${"b".repeat(64)}`;
function fixture() {
  const result = { endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid", service,
    issuer: "openclaw:thinkarr", keyId: "test-key", audience: "instance", bearer, credentialId, group: "120300000000@g.us", botNumber: "15555550100" };
  const run = vi.fn((args: string[]) => args[0] === "config" && args[1] === "get" ? JSON.stringify({ enabled: false }) : "{}");
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    if (url.pathname === "/api/mcp/info") { expect(init?.headers).toBeUndefined(); return Response.json({ version: 1, audience: "instance" }); }
    expect(url.href).toBe("https://thinkarr.invalid/api/mcp/setup");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${code}`);
    const body = JSON.parse(String(init?.body)); expect(Object.keys(body).sort()).toEqual(["issuer", "keyId", "publicKeyPem"]);
    expect(body.publicKeyPem).toContain("BEGIN PUBLIC KEY"); expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    return Response.json({ success: true, data: result });
  });
  return { result, run, fetch, setup: () => provisionConnection({ origin: "https://thinkarr.invalid", setupCode: code }, { fetch, run }) };
}
describe("trusted setup helper with native protected secrets", () => {
  it("discovers public metadata, enrolls via API, writes secrets only through stdin and configures references", async () => {
    const h = fixture(); const result = await h.setup();
    expect(result).toEqual({ status: "configured", service, credentialId, keyId: "test-key", enabled: false });
    const calls = h.run.mock.calls as unknown as Array<[string[], string?]>;
    const secretCalls = calls.filter(([args]) => args[0] === "secrets"); expect(secretCalls).toHaveLength(2);
    expect(secretCalls.every(([args]) => args.slice(-2).join(" ") === "--kind secret")).toBe(true);
    expect(secretCalls[0][1]).toContain("BEGIN PRIVATE KEY"); expect(secretCalls[1][1]).toBe(bearer);
    const configCall = calls.find(([args]) => args[0] === "config" && args[1] === "set")![0];
    const config = JSON.parse(configCall[3]);
    expect(config).not.toHaveProperty("credentialsFile");
    expect(config.connection.bearer).toMatchObject({ source: "store", provider: "default" });
    expect(config.connection.privateKeyPem).toMatchObject({ source: "store", provider: "default" });
    expect(config.accounts).toEqual({ default: "+15555550100" });
    expect(JSON.stringify(calls.map(([args]) => args))).not.toContain(bearer);
    expect(JSON.stringify([result, configCall])).not.toContain("BEGIN PRIVATE KEY");
  });
  it("does not re-enroll or rotate an existing native configuration", async () => {
    const h = fixture(); h.run.mockReturnValue(JSON.stringify({ enabled: true, config: { connection: { endpoint: h.result.endpoint, service, audience: "instance" } } }));
    const prompt = vi.fn(async () => { throw new Error("Should not request another owner grant"); });
    expect(await provisionConnection({ origin: "https://thinkarr.invalid", setupCode: prompt }, { fetch: h.fetch, run: h.run })).toEqual({ status: "already_configured" });
    expect(prompt).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("reuses a prepared secure Ed25519 key and refuses a world-readable source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thinkarr-setup-key-")); const path = join(directory, "key.pem");
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    try {
      await writeFile(path, privateKey, { mode: 0o600 });
      const h = fixture();
      await provisionConnection({ origin: "https://thinkarr.invalid", setupCode: code, keyFile: path }, { fetch: h.fetch, run: h.run });
      const request = JSON.parse(String(h.fetch.mock.calls[1][1]?.body));
      expect(request.publicKeyPem).toBe(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
      const calls = h.run.mock.calls as unknown as Array<[string[], string?]>;
      expect(calls.find(([args]) => args[0] === "secrets")![1]).toBe(privateKey);
      await chmod(path, 0o644); const blocked = fixture();
      await expect(provisionConnection({ origin: "https://thinkarr.invalid", setupCode: code, keyFile: path }, { fetch: blocked.fetch, run: blocked.run })).rejects.toThrow("preflight");
      expect(blocked.fetch).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["http://remote.invalid", "https://user:pass@thinkarr.invalid", "https://thinkarr.invalid/path", "https://thinkarr.invalid?token=secret"])("rejects unsafe discovery/enrollment origin %s", async (origin) => {
    const h = fixture(); await expect(provisionConnection({ origin, setupCode: code }, { fetch: h.fetch, run: h.run })).rejects.toThrow("preflight"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("never forwards reflected secrets or command diagnostics on a post-enrollment storage failure", async () => {
    const h = fixture(); h.run.mockImplementation((args) => { if (args[0] === "secrets") throw new Error(`SECRET ${bearer}`); return args[1] === "get" ? JSON.stringify({ enabled: false }) : "{}"; });
    const result = h.setup(); await expect(result).rejects.toThrow("native protected-secret storage");
    await expect(result).rejects.not.toThrow(bearer);
  });
  it("refuses changed audience/endpoint metadata without storing credentials", async () => {
    const h = fixture(); h.result.audience = "different";
    await expect(h.setup()).rejects.toThrow("API enrollment");
    expect(h.run.mock.calls.some(([args]) => args[0] === "secrets")).toBe(false);
  });
});
