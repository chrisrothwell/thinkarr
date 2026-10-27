// Validate the actual npm archive in a clean consumer installation, then export
// that same archive with a checksum and app/host compatibility metadata.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--output" && args[1]), "Usage: npm run pack:openclaw -- [--output directory]");
assert(process.env.npm_execpath, "Run through npm run pack:openclaw");
const npm = (command, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const work = await mkdtemp(join(tmpdir(), "thinkarr-openclaw-check-"));
let stage = "pack";
try {
  const pkg = JSON.parse(await readFile(join(root, "connectors/openclaw/package.json"), "utf8"));
  const app = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "@thinkarr/openclaw");
  const report = JSON.parse(npm(["pack", "./connectors/openclaw", "--ignore-scripts", "--json", "--pack-destination", work], root));
  // npm versions emit either an array or a package-name-keyed record.
  const packed = Array.isArray(report) ? report : Object.values(report);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, pkg.name); assert.equal(packed[0].version, pkg.version);
  const filename = packed[0].filename;
  assert.equal(filename, `thinkarr-openclaw-${pkg.version}.tgz`);
  assert.equal(basename(filename), filename);
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const required of ["package.json", "openclaw.plugin.json", "README.md", "SETUP.md", "skills/thinkarr/SKILL.md",
    "dist/openclaw/index.js", "dist/openclaw/setup.js", "dist/openclaw/secrets.js", "dist/openclaw/lifecycle.js", "dist/openclaw/reply-guard.js",
    "dist/delegated-mcp/linking.js", "dist/delegated-mcp/diagnostics.js", "dist/delegated-mcp/http-diagnostics.js", "dist/delegated-mcp/media-contract.js"]) {
    assert(files.has(required), `Missing packaged file: ${required}`);
  }
  for (const file of files) assert(
    ["package.json", "openclaw.plugin.json", "README.md", "SETUP.md", "skills/thinkarr/SKILL.md"].includes(file)
    || (/^dist\/(?:openclaw|delegated-mcp)\/[a-z0-9-]+\.(?:js|d\.ts)$/.test(file)),
    "Unexpected file in companion archive",
  );
  const archive = join(work, filename);
  const consumer = join(work, "consumer"); await mkdir(consumer);
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", consumer], { stdio: "pipe" });
  const shipped = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(consumer, "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(shipped, pkg);
  assert.equal(manifest.id, "thinkarr");
  assert.deepEqual(shipped.openclaw.extensions, ["./dist/openclaw/index.js"]);
  assert.deepEqual(manifest.skills, ["./skills"]);

  stage = "clean_runtime_dependencies";
  // No workspace node_modules, dev dependencies, install scripts or host runtime
  // are borrowed. Engine checks cover the consumer's real Node version too.
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict"], consumer);
  stage = "clean_runtime_audit";
  npm(["audit", "--omit=dev", "--audit-level=low"], consumer);
  stage = "packaged_runtime_smoke";
  const controller = new AbortController(); const cleanups = [];
  const factories = new Map(); const hooks = new Set(); const records = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Package registration must not perform network I/O"); };
  try {
    const { default: plugin } = await import(pathToFileURL(join(consumer, shipped.openclaw.extensions[0])).href);
    const logger = { info: (line) => records.push(line), warn: (line) => records.push(line), error: (line) => records.push(line) };
    const result = plugin.register({
      registrationMode: "full", config: {}, logger,
      pluginConfig: {
        accounts: { default: "+15555550100" }, pilotGroup: "120300000000@g.us", debug: false,
        connection: { endpoint: "https://example.invalid/api/mcp", publicLinkOrigin: "https://example.invalid",
          service: "00000000-0000-4000-8000-000000000001", issuer: "package-smoke", audience: "package-smoke", keyId: "package-smoke",
          bearer: `thk_svc_smoke.${"0".repeat(64)}`, privateKeyPem: "unused-registration-placeholder" },
      },
      lifecycle: { signal: controller.signal, onDispose: (cleanup) => { cleanups.push(cleanup); return () => {}; }, runInBackgroundContext: (run) => run() },
      runtime: { version: shipped.peerDependencies.openclaw, channel: { outbound: { loadAdapter: async () => { throw new Error("Registration must not load an outbound adapter"); } } } },
      registerTool: (factory, options) => { assert.equal(factory.contextVersion, 2); for (const name of options.names) { assert(!factories.has(name)); factories.set(name, factory); } },
      on: (name) => hooks.add(name),
    });
    assert.equal(result, undefined, "Registration must remain synchronous");
    assert.deepEqual([...factories.keys()].sort(), [...manifest.contracts.tools].sort());
    for (const name of ["before_dispatch", "reply_dispatch", "before_tool_call", "reply_payload_sending"]) assert(hooks.has(name), `Missing runtime hook: ${name}`);
    for (const [name, factory] of factories) {
      const context = { sessionKey: "package-smoke", messageChannel: "whatsapp", agentAccountId: "default", requesterSenderId: "+15555550101", nativeChannelId: "120300000000@g.us", assertInvocationCurrent() {} };
      const tool = factory.create(context); assert.equal(tool?.name, name); assert.equal(typeof tool.execute, "function");
      assert.equal(tool.parameters.additionalProperties, false);
      if (name.startsWith("thinkarr_media_")) assert.notEqual(tool.catalogMode, "direct-only", "Media tools must remain Code Mode callable");
      assert.equal(factory.create({ sessionKey: context.sessionKey, assertInvocationCurrent() {} }), null, "Context-free catalogs must not infer a participant");
    }
    const lifecycle = records.map((line) => JSON.parse(line.slice("[thinkarr] ".length))).find((record) => record.stage === "lifecycle.ready");
    assert.equal(lifecycle?.companionVersion, shipped.version);
  } finally {
    controller.abort(); for (const cleanup of cleanups) await cleanup(); globalThis.fetch = originalFetch;
  }

  stage = "export";
  const output = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), "thinkarr-openclaw-artifact-"));
  await mkdir(output, { recursive: true });
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  const metadata = { appVersion: app.version, companionVersion: shipped.version, openclawVersion: shipped.peerDependencies.openclaw,
    nodeVersion: process.version, filename, sha256, ...(/^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA ?? "") ? { sourceCommit: process.env.GITHUB_SHA } : {}) };
  // Do not overwrite a different build under an existing version filename.
  await copyFile(archive, join(output, filename), constants.COPYFILE_EXCL);
  await writeFile(join(output, `${filename}.sha256`), `${sha256}  ${filename}\n`, { flag: "wx" });
  await writeFile(join(output, "thinkarr-openclaw-release.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: "validated", output, ...metadata }, null, 2));
} catch (error) {
  console.error(`Companion package validation failed at ${stage}${error?.code === "EEXIST" ? ": output already exists; use a fresh directory" : ""}.`);
  if (error instanceof assert.AssertionError) console.error(error.message);
  process.exitCode = 1;
} finally { await rm(work, { recursive: true, force: true }); }
