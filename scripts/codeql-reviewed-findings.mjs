// Explicitly reviewed GitHub false positives only; never infer trust from a path.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export async function sourceDigest(root) {
  const files = ["package.json", "package-lock.json"];
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (path === "src/__tests__") continue;
      if (entry.isSymbolicLink()) throw new Error("Unverifiable source tree");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk("src");
  const digest = createHash("sha256");
  for (const path of files.sort()) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error("Unverifiable source file");
    const hash = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    digest.update(`${path}\0${hash}\n`);
  }
  return digest.digest("hex");
}

const locationKey = (location) => JSON.stringify([
  location.path, location.startLine, location.endLine, location.startColumn, location.endColumn,
]);
const validLocation = (location) => location && typeof location.path === "string" &&
  /^src\/[A-Za-z0-9_./[\]-]+$/.test(location.path) &&
  !location.path.split("/").some((part) => !part || part === "." || part === "..") &&
  ["startLine", "endLine", "startColumn", "endColumn"].every((key) => Number.isSafeInteger(location[key]) && location[key] > 0) &&
  location.endLine >= location.startLine;

export async function loadReview(policyPath, root, env = process.env) {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  if (policy.version !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository ?? "") ||
    !/^[a-f0-9]{64}$/.test(policy.sourceSha256 ?? "") || !Array.isArray(policy.findings)) throw new Error("Invalid review policy");
  const entries = new Map(); const alertNumbers = new Set();
  for (const entry of policy.findings) {
    if (!Number.isSafeInteger(entry.alertNumber) || entry.alertNumber <= 0 ||
      !/^[a-zA-Z0-9_./-]{1,100}$/.test(entry.ruleId ?? "") || !validLocation(entry.location)) throw new Error("Invalid review entry");
    const key = `${entry.ruleId}:${locationKey(entry.location)}`;
    if (entries.has(key) || alertNumbers.has(entry.alertNumber)) throw new Error("Ambiguous review entry");
    entries.set(key, entry); alertNumbers.add(entry.alertNumber);
  }
  let checkedSource = false;
  const accepted = new Set();
  return async (ruleId, result) => {
    if (result.locations?.length !== 1) return false;
    const physical = result.locations[0].physicalLocation;
    const region = physical?.region && { ...physical.region, endLine: physical.region.endLine ?? physical.region.startLine };
    const uri = physical?.artifactLocation?.uri;
    const base = physical?.artifactLocation?.uriBaseId;
    if (base !== undefined && base !== "%SRCROOT%") return false;
    if (typeof uri !== "string" || !validLocation({ path: uri, ...region })) return false;
    // Only exact, repository-relative result locations can consume a review.
    if (relative(resolve(root), resolve(root, uri)).startsWith("..")) return false;
    const location = { path: uri, startLine: region.startLine, endLine: region.endLine,
      startColumn: region.startColumn, endColumn: region.endColumn };
    const key = `${ruleId}:${locationKey(location)}`;
    const entry = entries.get(key);
    if (!entry) return false;
    if (accepted.has(key)) throw new Error("Duplicate reviewed finding");
    if (!checkedSource) {
      if (await sourceDigest(root) !== policy.sourceSha256) throw new Error("Reviewed source changed");
      checkedSource = true;
    }
    if (env.GITHUB_REPOSITORY !== policy.repository || !env.GH_TOKEN) throw new Error("Review authority unavailable");
    const [owner, repository] = policy.repository.split("/");
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/code-scanning/alerts/${entry.alertNumber}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Review authority unavailable");
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("Invalid review response");
    const alert = JSON.parse(text);
    if (alert.number !== entry.alertNumber || alert.rule?.id !== ruleId || alert.state !== "dismissed" ||
      alert.dismissed_reason !== "false positive" || !alert.dismissed_by?.login || !alert.dismissed_at ||
      alert.most_recent_instance?.location?.path !== location.path) throw new Error("Review no longer accepted");
    accepted.add(key);
    return true;
  };
}
