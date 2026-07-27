/**
 * getDb() — schema-integrity failures must not be cached
 *
 * Regression test for a production incident (beta, 2026-07-27): a live
 * database was missing the mcp_channel_identities/mcp_registration_tokens/
 * mcp_pending_baskets tables even though __drizzle_migrations recorded them as
 * applied. ensureSchemaIntegrity() correctly threw — but getDb() assigned the
 * module-level `_db` cache *before* running the integrity check, so the throw
 * only surfaced on the very first call after a process start. Every
 * subsequent getDb() call in that same process silently returned the cached
 * (broken) handle instead of re-checking, so the failure produced one log
 * line at boot and then went completely quiet — even though the underlying
 * tables were still missing and any query against them would fail.
 *
 * getDb() must instead keep retrying (and re-throwing) on every call until
 * the underlying schema is actually fixed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkarr-getdb-cache-test-"));
  dbPath = path.join(tmpDir, "thinkarr.db");
  process.env.CONFIG_DIR = tmpDir;
});

/** Build a DB file with all migrations applied, then break it exactly like the beta incident. */
function createBrokenDb(): void {
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_DIR });
  sqlite.exec("DROP TABLE mcp_channel_identities");
  sqlite.close();
}

async function importGetDb() {
  vi.resetModules();
  const mod = await import("@/lib/db");
  return mod.getDb;
}

describe("getDb() — does not cache a handle across a failed integrity check", () => {
  it("throws again on the second call, not just the first", async () => {
    createBrokenDb();
    const getDb = await importGetDb();

    expect(() => getDb()).toThrow(/mcp_channel_identities/);
    // Before the fix, this second call returned the module-level `_db` cache
    // populated by the failed first attempt, instead of re-running
    // ensureSchemaIntegrity — i.e. it silently stopped throwing.
    expect(() => getDb()).toThrow(/mcp_channel_identities/);
  });

  it("succeeds once the underlying schema is repaired, without restarting the process", async () => {
    createBrokenDb();
    const getDb = await importGetDb();

    expect(() => getDb()).toThrow(/mcp_channel_identities/);

    // Repair the table on disk (mirrors an operator running the migration
    // SQL manually) — no process restart.
    const repair = new Database(dbPath);
    repair.exec(`
      CREATE TABLE mcp_channel_identities (
        channel_type text NOT NULL,
        channel_user_id text NOT NULL,
        user_id integer NOT NULL,
        created_at integer NOT NULL,
        PRIMARY KEY(channel_type, channel_user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );
    `);
    repair.close();

    expect(() => getDb()).not.toThrow();
  });
});
