/**
 * Creates a SQLite database in the "dirty migration" state used by the CI
 * Docker smoke test (docker-publish.yml).
 *
 * State produced:
 *   - All migrations have been applied and recorded in __drizzle_migrations
 *     with the correct content-hashes that drizzle uses for tracking.
 *   - The `duration_ms` column is then dropped from `messages`, simulating a
 *     DB file restored from a backup taken before migration 0001 ran while
 *     __drizzle_migrations still reflects the post-migration state.
 *
 * When the container starts with this DB:
 *   - migrate() sees 0001 in __drizzle_migrations and skips it.
 *   - The defensive fallback in getDb() must add duration_ms back.
 *   - GET /api/health must return 200 (proves the fallback fired).
 *
 * Usage:
 *   node scripts/create-dirty-db.cjs <output-directory>
 *
 * The .cjs extension ensures CommonJS semantics regardless of the package.json
 * "type" field — both drizzle-orm and better-sqlite3 ship CJS builds.
 */
"use strict";

const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
const path = require("path");
const fs = require("fs");

const dirtyDir = process.argv[2];
if (!dirtyDir) {
  console.error("Usage: node scripts/create-dirty-db.cjs <output-directory>");
  process.exit(1);
}

fs.mkdirSync(dirtyDir, { recursive: true });

const dbPath = path.join(dirtyDir, "thinkarr.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Apply all migrations so __drizzle_migrations has the correct hashes
migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), "drizzle") });

const colsBefore = sqlite
  .prepare("PRAGMA table_info(messages)")
  .all()
  .map((c) => c.name);
console.log("Columns before dirty state:", colsBefore.join(", "));

// Drop the column to simulate a DB restored from a pre-migration backup.
// SQLite >= 3.35.0 is required (better-sqlite3 v12 bundles >= 3.46).
sqlite.exec("ALTER TABLE messages DROP COLUMN duration_ms");

const colsAfter = sqlite
  .prepare("PRAGMA table_info(messages)")
  .all()
  .map((c) => c.name);
console.log("Columns after dirty state: ", colsAfter.join(", "));
console.log(`Dirty DB written to:        ${dbPath}`);
console.log(
  "State: __drizzle_migrations shows 0001 applied; duration_ms column absent",
);

sqlite.close();
