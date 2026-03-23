/**
 * Migration Safety Linter
 *
 * Parses every SQL file in drizzle/ and enforces rules that protect users
 * with existing databases from being broken on upgrade.
 *
 * Rules enforced:
 *   1. ADD COLUMN NOT NULL must have a DEFAULT (SQLite rejects this on non-empty tables)
 *   2. DROP TABLE must be paired with CREATE TABLE in the same file (data-loss guard)
 *
 * When you INTENTIONALLY drop a table, add its name to ALLOWED_DROPS below.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const DRIZZLE_DIR = path.join(process.cwd(), "drizzle");
const JOURNAL_PATH = path.join(DRIZZLE_DIR, "meta/_journal.json");

/** Tables that are intentionally dropped without recreation. Add names here to allow. */
const ALLOWED_DROPS: string[] = [];

function getSqlFiles(): string[] {
  return fs
    .readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readFile(name: string): string {
  return fs.readFileSync(path.join(DRIZZLE_DIR, name), "utf-8");
}

describe("Migration safety linter", () => {
  it("finds at least one migration file", () => {
    expect(getSqlFiles().length).toBeGreaterThan(0);
  });

  it("all migration files are non-empty and readable", () => {
    for (const file of getSqlFiles()) {
      const content = readFile(file);
      expect(content.trim().length, `${file} is empty`).toBeGreaterThan(0);
    }
  });

  it("migration files follow the Drizzle sequential-number naming convention", () => {
    for (const file of getSqlFiles()) {
      expect(file, `${file} does not follow 0000_*.sql naming`).toMatch(/^\d{4}_/);
    }
  });

  it("no migration adds a NOT NULL column without a DEFAULT (would break existing databases)", () => {
    const violations: string[] = [];

    for (const file of getSqlFiles()) {
      const lines = readFile(file).split("\n");

      for (let i = 0; i < lines.length; i++) {
        const upper = lines[i].toUpperCase();

        if (!upper.includes("ADD COLUMN")) continue;
        if (!upper.includes("NOT NULL")) continue;

        // Collect the column definition (may span the current line only in Drizzle-generated SQL)
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join(" ")
          .toUpperCase();

        if (!context.includes("DEFAULT")) {
          violations.push(`  ${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "Breaking migration: ADD COLUMN NOT NULL without DEFAULT will fail on non-empty databases.",
          "Fix: add a DEFAULT value or make the column nullable.",
          "",
          ...violations,
        ].join("\n"),
      );
    }
  });

  it("_journal.json is valid JSON and has an entries array", () => {
    const raw = fs.readFileSync(JOURNAL_PATH, "utf-8");
    const journal = JSON.parse(raw) as { entries?: unknown };
    expect(Array.isArray(journal.entries), "_journal.json must have an entries array").toBe(true);
  });

  it("every _journal.json entry has a corresponding .sql file (missing file = migration never runs)", () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: { tag: string }[];
    };
    const missing = journal.entries
      .filter((e) => !fs.existsSync(path.join(DRIZZLE_DIR, `${e.tag}.sql`)))
      .map((e) => `  ${e.tag}.sql`);
    if (missing.length > 0) {
      throw new Error(
        [
          "Journal entries with no matching .sql file — drizzle will skip these silently:",
          ...missing,
          "Fix: run `npx drizzle-kit generate` or add the missing .sql file.",
        ].join("\n"),
      );
    }
  });

  it("every .sql migration file has a corresponding _journal.json entry (missing entry = migration never runs)", () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: { tag: string }[];
    };
    const journalTags = new Set(journal.entries.map((e) => e.tag));
    const missing = getSqlFiles()
      .filter((f) => !journalTags.has(f.replace(/\.sql$/, "")))
      .map((f) => `  ${f}`);
    if (missing.length > 0) {
      throw new Error(
        [
          "SQL files not referenced in drizzle/meta/_journal.json — drizzle will never run these:",
          ...missing,
          "Fix: run `npx drizzle-kit generate` to regenerate the journal, or add the entry manually.",
        ].join("\n"),
      );
    }
  });

  it("no migration silently drops a table without recreating it in the same file", () => {
    const violations: string[] = [];

    for (const file of getSqlFiles()) {
      const content = readFile(file);
      const upper = content.toUpperCase();

      const dropPattern = /DROP TABLE(?:\s+IF\s+EXISTS)?\s+`?(\w+)`?/gi;
      let match: RegExpExecArray | null;

      while ((match = dropPattern.exec(content)) !== null) {
        const tableName = match[1].toUpperCase();

        if (ALLOWED_DROPS.map((t) => t.toUpperCase()).includes(tableName)) continue;

        const hasCreate =
          upper.includes(`CREATE TABLE ${tableName}`) ||
          upper.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`) ||
          upper.includes(`CREATE TABLE \`${tableName}\``);

        if (!hasCreate) {
          violations.push(
            `  ${file}: DROP TABLE ${match[1]} — no matching CREATE TABLE found in the same file.` +
              ` If intentional, add '${match[1]}' to ALLOWED_DROPS in migration-safety.test.ts`,
          );
        }
      }
    }

    expect(violations, violations.join("\n")).toHaveLength(0);
  });
});
