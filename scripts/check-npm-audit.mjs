#!/usr/bin/env node
/**
 * Runs `npm audit` against production dependencies only (devDependencies —
 * eslint, drizzle-kit, vite, etc. — never reach the shipped Docker image, so
 * their transitive vulnerabilities have no runtime attack surface) and fails
 * on ANY finding at ANY severity, not just high/critical.
 *
 * `.npmauditignore` (same format/spirit as .trivyignore) lists GHSA IDs that
 * are temporarily allowed through — e.g. a production dependency vulnerability
 * that's blocked on an upstream package publishing a fix. Each entry must have
 * a comment explaining why and what condition removes it. This is a deliberate,
 * reviewed exception, not a way to silence audit noise.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const IGNORE_FILE = ".npmauditignore";

function loadIgnoreList() {
  if (!existsSync(IGNORE_FILE)) return new Set();
  const lines = readFileSync(IGNORE_FILE, "utf8").split("\n");
  const ids = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return new Set(ids);
}

function extractGhsaId(url) {
  const match = /GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.exec(url ?? "");
  return match ? match[0] : null;
}

const ignoreList = loadIgnoreList();

let report;
try {
  const raw = execSync("npm audit --omit=dev --json", { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  report = JSON.parse(raw);
} catch (e) {
  // npm audit exits non-zero when it finds vulnerabilities — that's expected,
  // the JSON is still on stdout.
  try {
    report = JSON.parse(e.stdout);
  } catch {
    console.error("Failed to run or parse `npm audit --omit=dev --json`:");
    console.error(e.stdout || e.message);
    process.exit(1);
  }
}

const vulnerabilities = report.vulnerabilities ?? {};
const blocking = [];
const allowed = [];

for (const [pkg, vuln] of Object.entries(vulnerabilities)) {
  const advisories = (vuln.via ?? []).filter((v) => typeof v === "object");
  if (advisories.length === 0) {
    // Purely a transitive marker (e.g. "depends on vulnerable versions of X")
    // with no advisory of its own — the real advisory is reported under the
    // dependency it names, so nothing to check here.
    continue;
  }
  for (const advisory of advisories) {
    const ghsaId = extractGhsaId(advisory.url);
    const entry = { pkg, severity: advisory.severity, title: advisory.title, url: advisory.url, ghsaId };
    if (ghsaId && ignoreList.has(ghsaId)) {
      allowed.push(entry);
    } else {
      blocking.push(entry);
    }
  }
}

if (allowed.length > 0) {
  console.log(`Allowed via ${IGNORE_FILE} (${allowed.length}):`);
  for (const a of allowed) {
    console.log(`  - [${a.severity}] ${a.pkg}: ${a.title} (${a.ghsaId})`);
  }
}

if (blocking.length > 0) {
  console.error(`\nBlocking production-dependency vulnerabilities (${blocking.length}):`);
  for (const b of blocking) {
    console.error(`  - [${b.severity}] ${b.pkg}: ${b.title} (${b.ghsaId ?? "no GHSA ID"}) — ${b.url}`);
  }
  console.error(
    `\nFix these, or if genuinely blocked on an upstream release, add the GHSA ID to ${IGNORE_FILE} with a comment explaining why and what removes it.`,
  );
  process.exit(1);
}

console.log("\nNo blocking production-dependency vulnerabilities.");
