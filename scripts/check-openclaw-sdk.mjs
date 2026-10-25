// Compile against published SDK declarations, without executing/installing the
// OpenClaw runtime or its dependency tree. Registry archives are integrity pinned.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = resolve(root, "node_modules/.cache/thinkarr-openclaw-sdk");
await mkdir(cache, { recursive: true });
for (const [name, version, integrity] of [
  ["openclaw", "2026.10.4", "+FH0StZF1tlTazM7JJGY6JePeJmhFNSRByi2Q3jXPRiLO7o4dJh2xa9Vy4Dk8Cd2ic8B7Zkf5NfEaCCWUkgqnQ=="],
  ["typebox", "1.3.34", "wbnzrXXDW8xEFHDZZs2jo1MkhaYlKAY4FRhpBc1+2LF1fZVBGCXGdLEhA/Z/NBbgzJMFfeM8m7elKPa/+KxaUQ=="],
]) {
  const archive = resolve(cache, `${name}-${version}.tgz`);
  let bytes;
  try { bytes = await readFile(archive); } catch { /* download below */ }
  if (!bytes || createHash("sha512").update(bytes).digest("base64") !== integrity) {
    execFileSync("npm", ["pack", `${name}@${version}`, "--ignore-scripts", "--pack-destination", cache, "--silent"], { cwd: root, stdio: "pipe" });
    bytes = await readFile(archive);
  }
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) throw new Error(`Unexpected ${name} SDK archive integrity`);
  const destination = resolve(cache, "node_modules", name);
  await mkdir(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination, "--wildcards", "package/package.json", name === "openclaw" ? "package/dist/*.d.ts" : "package/build/*.d.mts"], { stdio: "pipe" });
}

const check = resolve(cache, "check.ts");
const adapter = resolve(root, "connectors/openclaw/index.ts").replaceAll("\\", "/");
await writeFile(check, `import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import plugin, { register } from ${JSON.stringify(adapter)};
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import type { PreparedPluginSecretReader } from ${JSON.stringify(resolve(root, "connectors/openclaw/secrets.ts").replaceAll("\\", "/"))};
const secretReader: PreparedPluginSecretReader = getPreparedPluginSecretInput;
void secretReader;
declare const api: OpenClawPluginApi;
register(api);
const definition: OpenClawPluginDefinition = plugin;
void definition;
`);
const program = ts.createProgram([check], {
  strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, esModuleInterop: true,
  types: ["node"], typeRoots: [resolve(root, "node_modules/@types")],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else console.log("OpenClaw 2026.10.4 published SDK registration contract passed.");
