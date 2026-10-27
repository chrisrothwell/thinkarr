import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
