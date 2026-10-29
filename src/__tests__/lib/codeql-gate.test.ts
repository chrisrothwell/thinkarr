import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "thinkarr-codeql-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const run = () => spawnSync(process.execPath, [resolve("scripts/check-codeql-sarif.mjs"), directory], { encoding: "utf8" });
async function report(result: object[], defaultLevel = "warning", extra = {}) {
  await writeFile(join(directory, "javascript.sarif"), JSON.stringify({ version: "2.1.0", runs: [{
    tool: { driver: { rules: [{ id: "js/fixture-rule", defaultConfiguration: { level: defaultLevel } }] } },
    results: result, ...extra,
  }] }));
}
describe("required CodeQL SARIF gate", () => {
  it("passes completed analysis with no findings", async () => {
    await report([]); expect(run().status).toBe(0);
  });
  it.each([true, false])("blocks effective error findings, including query defaults (explicit=%s)", async (explicit) => {
    await report([{ ruleId: "js/fixture-rule", ...(explicit ? { level: "error" } : {}), message: { text: "SECRET source context" } }], "error");
    const result = run(); expect(result.status).toBe(1);
    expect(result.stderr).toContain("js/fixture-rule"); expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET");
  });
  it("honors an explicit warning override rather than treating all findings as errors", async () => {
    await report([{ ruleIndex: 0, level: "warning" }], "error"); expect(run().status).toBe(0);
  });
  it("enforces defaults from extension query packs instead of silently using the driver default", async () => {
    await report([{ rule: { index: 0, toolComponent: { index: 0 } } }], "warning", {
      tool: { driver: { rules: [] }, extensions: [{ name: "security-pack", rules: [{ id: "js/extension-error", defaultConfiguration: { level: "error" } }] }] },
    });
    const result = run(); expect(result.status).toBe(1); expect(result.stderr).toContain("js/extension-error");
  });
  it("does not accept invalid severity levels or unresolved query references as a passing analysis", async () => {
    await report([{ level: "invalid", ruleIndex: 0 }]); expect(run().status).toBe(1);
    await report([{ ruleId: "js/missing-rule" }]); expect(run().status).toBe(1);
    await report([{ rule: { index: 0, toolComponent: { index: 99 } } }]); expect(run().status).toBe(1);
  });
  it("fails closed for missing, corrupt or failed analysis", async () => {
    expect(run().status).toBe(1);
    await writeFile(join(directory, "javascript.sarif"), "SECRET invalid report");
    const corrupt = run(); expect(corrupt.status).toBe(1); expect(corrupt.stderr).not.toContain("SECRET");
    await report([], "warning", { invocations: [{ executionSuccessful: false }] }); expect(run().status).toBe(1);
  });
});

const reviewedLocation = { path: "src/probe.ts", startLine: 1, endLine: 1, startColumn: 1, endColumn: 10 };
const reviewedResult = { ruleId: "js/fixture-rule", locations: [{ physicalLocation: {
  artifactLocation: { uri: reviewedLocation.path },
  region: { startLine: 1, endLine: 1, startColumn: 1, endColumn: 10 },
} }] };
async function reviewedFixture(alertPatch = {}, status = 200) {
  await mkdir(join(directory, "src"));
  const sources: Record<string, string> = { "package.json": "{}", "package-lock.json": "{}", "src/probe.ts": "validated-target", "src/guard.ts": "admin-only" };
  const digest = createHash("sha256");
  for (const path of Object.keys(sources).sort()) {
    await writeFile(join(directory, path), sources[path]);
    digest.update(`${path}\0${createHash("sha256").update(sources[path]).digest("hex")}\n`);
  }
  const policy = { version: 1, repository: "chrisrothwell/thinkarr", sourceSha256: digest.digest("hex"),
    findings: [{ alertNumber: 22, ruleId: "js/fixture-rule", location: reviewedLocation }] };
  const policyPath = join(directory, "review.json");
  await writeFile(policyPath, JSON.stringify(policy));
  const hook = join(directory, "mock-github.mjs");
  const alert = { number: 22, state: "dismissed", dismissed_reason: "false positive", dismissed_at: "2026-10-29T00:00:00Z",
    dismissed_by: { login: "owner" }, rule: { id: "js/fixture-rule" }, most_recent_instance: { location: { path: reviewedLocation.path } }, ...alertPatch };
  await writeFile(hook, `globalThis.fetch = async (url, options) => {
    if (url !== "https://api.github.com/repos/chrisrothwell/thinkarr/code-scanning/alerts/22" || options.redirect !== "error" || options.headers.Authorization !== "Bearer SECRET") throw new Error("SECRET invalid request");
    return new Response(${JSON.stringify(JSON.stringify(alert))}, {status:${status}});
  };`);
  await report([reviewedResult], "error");
  return { policy, policyPath, run: (env = {}) => spawnSync(process.execPath,
    ["--import", hook, resolve("scripts/check-codeql-sarif.mjs"), directory, "--reviewed-findings", policyPath],
    { cwd: directory, encoding: "utf8", env: { ...process.env, GH_TOKEN: "SECRET", GITHUB_REPOSITORY: "chrisrothwell/thinkarr", ...env } }) };
}

describe("source-bound GitHub false-positive review", () => {
  it("accepts only an exact result on reviewed source with a live false-positive dismissal", async () => {
    const fixture = await reviewedFixture(); const result = fixture.run();
    expect(result.status).toBe(0); expect(result.stdout).toContain("1 source-bound GitHub dismissal(s) verified");
    expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET");
  });
  it("uses the SARIF single-line endLine default without accepting another URI base", async () => {
    const fixture = await reviewedFixture();
    await report([{ ruleId: "js/fixture-rule", locations: [{ physicalLocation: {
      artifactLocation: { uri: reviewedLocation.path, uriBaseId: "%SRCROOT%" },
      region: { startLine: 1, startColumn: 1, endColumn: 10 },
    } }] }], "error");
    expect(fixture.run().status).toBe(0);
    await report([{ ruleId: "js/fixture-rule", locations: [{ physicalLocation: {
      artifactLocation: { uri: reviewedLocation.path, uriBaseId: "%OTHERROOT%" },
      region: { startLine: 1, startColumn: 1, endColumn: 10 },
    } }] }], "error");
    expect(fixture.run().status).toBe(1);
  });
  it.each([
    { state: "open" }, { state: "fixed" }, { dismissed_reason: "won't fix" }, { dismissed_reason: "used in tests" },
    { dismissed_by: null }, { dismissed_at: null }, { number: 23 }, { rule: { id: "js/other" } },
    { most_recent_instance: { location: { path: "src/other.ts" } } },
  ])("fails closed when the remote review is not the exact accepted finding (%j)", async (patch) => {
    const fixture = await reviewedFixture(patch); const result = fixture.run();
    expect(result.status).toBe(1); expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET");
  });
  it.each([403, 404, 500])("fails closed when GitHub review verification returns HTTP%s", async (status) => {
    const fixture = await reviewedFixture({}, status); expect(fixture.run().status).toBe(1);
  });
  it("rejects missing credentials or a different repository", async () => {
    const fixture = await reviewedFixture();
    expect(fixture.run({ GH_TOKEN: "" }).status).toBe(1);
    expect(fixture.run({ GITHUB_REPOSITORY: "other/repository" }).status).toBe(1);
  });
  it.each(["src/probe.ts", "src/guard.ts", "package.json", "package-lock.json", "src/new-entrypoint.ts"])("invalidates acceptance when runtime source or dependencies change (%s)", async (path) => {
    const fixture = await reviewedFixture(); await writeFile(join(directory, path), "SECRET changed code");
    const result = fixture.run(); expect(result.status).toBe(1); expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET");
  });
  it("does not apply a review to another location or unreviewed error", async () => {
    const fixture = await reviewedFixture();
    await report([{ ...reviewedResult, locations: [{ physicalLocation: { artifactLocation: { uri: "src/guard.ts" }, region: { startLine: 1, endLine: 1, startColumn: 1, endColumn: 10 } } }] }], "error");
    expect(fixture.run().status).toBe(1);
    await report([reviewedResult, { level: "error", ruleId: "js/new-error" }], "error");
    const result = fixture.run(); expect(result.status).toBe(1); expect(result.stderr).toContain("js/new-error");
  });
  it("rejects ambiguous, duplicate or malformed policy entries instead of broadening acceptance", async () => {
    const fixture = await reviewedFixture();
    await writeFile(fixture.policyPath, JSON.stringify({ ...fixture.policy, findings: [...fixture.policy.findings, ...fixture.policy.findings] }));
    expect(fixture.run().status).toBe(1);
    await writeFile(fixture.policyPath, "SECRET invalid JSON");
    const result = fixture.run(); expect(result.status).toBe(1); expect(result.stderr).not.toContain("SECRET");
  });
  it("retains strict rejection when no reviewed-findings policy is requested", async () => {
    await reviewedFixture(); expect(run().status).toBe(1);
  });
});
