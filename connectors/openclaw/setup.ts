#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";

type Run = (args: string[], input?: string) => string;
type SetupOptions = { origin: string; setupCode: string | (() => Promise<string>); account?: string; keyFile?: string; secretProvider?: string };
const info = z.object({ version: z.literal(1), audience: z.string().min(1).max(200) }).strict();
const connection = z.object({
  endpoint: z.string().url(), publicLinkOrigin: z.string().url(), service: z.string().uuid(),
  issuer: z.string().min(1).max(200), keyId: z.string().min(1).max(80), audience: z.string().min(1).max(200),
  bearer: z.string().regex(/^thk_svc_[a-f0-9-]{36}\.[a-f0-9]{64}$/), credentialId: z.string().uuid(),
  group: z.string().max(512).regex(/^[0-9]+(?:-[0-9]+)?@g\.us$/), botNumber: z.string().regex(/^\+?[1-9][0-9]{6,14}$/),
}).strict();

async function existingKey(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error();
    return createPrivateKey(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}

/** Trusted local setup process: values go HTTP → stdin → native protected store,
 * never command arguments, custom credential files, stdout or model results.
 */
export async function provisionConnection(options: SetupOptions, deps: { fetch?: typeof fetch; run?: Run } = {}) {
  let phase = "preflight"; let credentialId: string | undefined; let enrollmentAttempted = false; let apiStatus: number | undefined;
  try {
    const origin = new URL(options.origin);
    if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
      || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    const account = z.string().min(1).max(512).parse(options.account ?? "default");
    const provider = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).parse(options.secretProvider ?? "default");
    const run: Run = deps.run ?? ((args, input) => execFileSync("openclaw", args, { input, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }));
    run(["plugins", "inspect", "thinkarr", "--json"]);
    const entry = JSON.parse(run(["config", "get", "plugins.entries.thinkarr", "--json"]));
    if (entry.config?.connection) {
      z.object({ endpoint: z.literal(new URL("/api/mcp", origin).href), service: z.string().uuid(), audience: z.string().min(1) }).parse(entry.config.connection);
      return { status: "already_configured" as const };
    }
    if (entry.enabled === true) throw new Error();
    const code = typeof options.setupCode === "function" ? await options.setupCode() : options.setupCode;
    if (!/^thk_setup_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(code)) throw new Error();
    const key = options.keyFile ? await existingKey(options.keyFile) : generateKeyPairSync("ed25519").privateKey;
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = key.export({ type: "pkcs8", format: "pem" }).toString();
    const request = deps.fetch ?? globalThis.fetch;
    const signal = AbortSignal.timeout(60_000);
    async function json(path: string, init: RequestInit = {}) {
      signal.throwIfAborted();
      const response = await request(new URL(path, origin), { ...init, redirect: "error", credentials: "omit", signal });
      if (!response.ok) { apiStatus = response.status; throw new Error(); }
      if (response.redirected || !response.body) throw new Error();
      const reader = response.body.getReader(); const parts = []; let length = 0;
      try {
        while (true) {
          const next = await reader.read(); signal.throwIfAborted();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 65_536) throw new Error();
          parts.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    }
    phase = "public metadata discovery";
    const metadata = info.parse(await json("/api/mcp/info"));
    phase = "API enrollment";
    enrollmentAttempted = true;
    const enrolled = z.object({ success: z.literal(true), data: connection }).strict().parse(await json("/api/mcp/setup", { method: "POST", headers: {
      Authorization: `Bearer ${code}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ issuer: "openclaw:thinkarr", keyId: `key-${randomUUID()}`, publicKeyPem }) })).data;
    credentialId = enrolled.credentialId;
    if (enrolled.audience !== metadata.audience || enrolled.publicLinkOrigin !== origin.origin || enrolled.endpoint !== new URL("/api/mcp", origin).href) throw new Error();
    const suffix = createHash("sha256").update(enrolled.keyId).digest("hex").slice(0, 8).toUpperCase();
    const prefix = `THINKARR_${enrolled.service.replaceAll("-", "").toUpperCase()}_${suffix}`;
    const privateName = `${prefix}_PRIVATE_KEY`; const bearerName = `${prefix}_SERVICE_TOKEN`;
    phase = "native protected-secret storage";
    run(["secrets", "store", "set", privateName, "--kind", "secret"], privateKeyPem);
    run(["secrets", "store", "set", bearerName, "--kind", "secret"], enrolled.bearer);
    const ref = (id: string) => ({ source: "store", provider, id });
    const config = { accounts: { [account]: `+${enrolled.botNumber.replace(/^\+/, "")}` }, pilotGroup: enrolled.group,
      connection: { endpoint: enrolled.endpoint, publicLinkOrigin: enrolled.publicLinkOrigin, service: enrolled.service,
        issuer: enrolled.issuer, keyId: enrolled.keyId, audience: enrolled.audience, bearer: ref(bearerName), privateKeyPem: ref(privateName) } };
    phase = "plugin configuration";
    run(["config", "set", "plugins.entries.thinkarr.config", JSON.stringify(config), "--strict-json"]);
    return { status: "configured" as const, service: enrolled.service, credentialId, keyId: enrolled.keyId, enabled: false };
  } catch {
    throw new Error(`Thinkarr setup failed during ${phase}${apiStatus ? ` (HTTP ${apiStatus})` : ""}.${credentialId ? ` Credential ${credentialId} was issued; revoke it in Thinkarr before a new enrollment if local setup did not complete.` : enrollmentAttempted ? " Enrollment may have completed; inspect the integration credential in Thinkarr before another enrollment." : " No raw diagnostics or credentials are printed."}`);
  }
}

async function setupCode() {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) { value += chunk.toString(); if (value.length > 256) throw new Error(); }
    return value.trim();
  }
  process.stdout.write("Enter the one-use Thinkarr setup code (hidden): ");
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise<string>((resolve, reject) => {
    terminal.once("line", (line) => { terminal.close(); process.stdout.write("\n"); resolve(line.trim()); });
    terminal.once("SIGINT", () => { terminal.close(); reject(new Error()); });
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const known = new Set(["--origin", "--account", "--key-file", "--secret-provider"]);
    if (args.length % 2 || args.some((value, index) => index % 2 === 0 ? !known.has(value) : value.startsWith("--"))) throw new Error("Invalid setup options; provide a value for each supported option.");
    const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const origin = option("--origin");
    if (!origin) throw new Error("Usage: node setup.js --origin https://thinkarr.example.com [--account default] [--key-file /protected/existing-key.pem]");
    const result = await provisionConnection({ origin, setupCode, account: option("--account"), keyFile: option("--key-file"), secretProvider: option("--secret-provider") });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error instanceof Error ? error.message : "Thinkarr setup failed"); process.exitCode = 1; }
}
