import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns, getTableName, is, eq } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { logger } from "@/lib/logger";

const DB_DIR = process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const DB_PATH = path.join(DB_DIR, "thinkarr.db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Compares every table in schema.ts against the live SQLite database and
 * applies any safe corrections.
 *
 * SAFE (auto-fixed):   nullable columns — existing rows receive NULL.
 * UNSAFE (crash):      NOT NULL columns — we cannot know the correct backfill
 *                      value for existing rows without the original migration SQL.
 *                      The process exits so the operator can intervene rather
 *                      than silently serving 500s.
 *
 * This runs after migrate() so it only fires when __drizzle_migrations has
 * recorded a migration as applied but the ALTER TABLE SQL never actually ran
 * (e.g. DB restored from a backup taken before that migration ran, or a
 * crash/rollback mid-migration).
 *
 * Emits one log line per table so startup logs give a complete schema snapshot
 * that can be used to diagnose drift without needing shell access to the container.
 *
 * Exported for unit testing.
 */
export function ensureSchemaIntegrity(sqlite: Database.Database): void {
  type ColRow = { name: string };

  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is SQLiteTable => is(v, SQLiteTable),
  );

  for (const table of tables) {
    const tableName = getTableName(table);
    const expectedCols = Object.values(getTableColumns(table));
    const actualNames = new Set(
      (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as ColRow[]).map(
        (r) => r.name,
      ),
    );

    const repaired: string[] = [];

    for (const col of expectedCols) {
      if (actualNames.has(col.name)) continue;

      if (col.notNull) {
        // Cannot safely synthesise a backfill value for NOT NULL columns.
        // Crash loudly — the operator must restore the missing migration or
        // manually run the ALTER TABLE SQL before restarting.
        logger.error("Schema integrity failure — NOT NULL column missing", {
          tableName,
          column: col.name,
          expectedColumns: expectedCols.map((c) => c.name),
          actualColumns: [...actualNames],
          hint: "The migration may not have applied cleanly. Verify __drizzle_migrations and run the migration SQL manually, then restart.",
        });
        throw new Error(
          `Schema integrity failure: "${tableName}"."${col.name}" is NOT NULL ` +
            `and cannot be auto-repaired. Check __drizzle_migrations, ensure ` +
            `the migration ran successfully, then restart.`,
        );
      }

      // Nullable column — safe to add; existing rows receive NULL.
      const typeSql = col.getSQLType();
      sqlite.exec(
        `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${typeSql}`,
      );
      repaired.push(col.name);
      logger.warn("Schema drift corrected: added missing nullable column", {
        tableName,
        column: col.name,
        type: typeSql,
      });
    }

    // One log line per table — gives a full schema snapshot at startup.
    if (repaired.length === 0) {
      logger.info(`Schema integrity — ${tableName}`, {
        columns: expectedCols.length,
        status: "OK",
      });
    } else {
      logger.info(`Schema integrity — ${tableName}`, {
        columns: expectedCols.length,
        repaired,
        status: "repaired",
      });
    }
  }
}

export function getDb() {
  if (!_db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    _db = drizzle(sqlite, { schema });

    // ── 1. File metadata ─────────────────────────────────────────────────────
    // Logged first so it appears in output even if a later step crashes.
    // mtime and size reveal whether the DB file was recently replaced (e.g.
    // restored from a backup), which is the root cause of dirty-migration states.
    const { sqliteVersion } = sqlite
      .prepare("SELECT sqlite_version() AS sqliteVersion")
      .get() as { sqliteVersion: string };
    const dbStat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
    logger.info("Database initializing", {
      path: DB_PATH,
      sqliteVersion,
      sizeBytes: dbStat?.size ?? 0,
      mtime: dbStat?.mtime?.toISOString() ?? "n/a",
    });

    // ── 2. Migration state BEFORE migrate() ──────────────────────────────────
    // Knowing which migrations were already tracked lets you spot the dirty state:
    // "migration 0001 was applied 3 days ago but the column is missing today."
    type MigRow = { hash: string };
    const migrationsPath = path.join(process.cwd(), "drizzle");
    const hasMigrationsTable = !!sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
      )
      .get();

    let beforeHashes = new Set<string>();
    if (hasMigrationsTable) {
      const before = sqlite
        .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
        .all() as MigRow[];
      beforeHashes = new Set(before.map((m) => m.hash));
      logger.info("Migration tracking: previously applied", {
        count: before.length,
        hashes: before.map((m) => m.hash),
      });
    } else {
      logger.info("Migration tracking: fresh database (no __drizzle_migrations table yet)");
    }

    // ── 3. Run migrations ────────────────────────────────────────────────────
    if (fs.existsSync(migrationsPath)) {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsPath });

      // Log exactly which migrations ran so the distinction between
      // "already applied" and "newly applied" is unambiguous in the output.
      const after = sqlite
        .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
        .all() as MigRow[];
      const newlyApplied = after.filter((m) => !beforeHashes.has(m.hash));

      if (newlyApplied.length > 0) {
        logger.info("Migrations applied", {
          count: newlyApplied.length,
          hashes: newlyApplied.map((m) => m.hash),
        });
      } else {
        logger.info("Migrations: schema already up to date", {
          totalApplied: after.length,
        });
      }
    }

    // ── 4. Schema integrity check ────────────────────────────────────────────
    // Logs one line per table (OK / repaired / throws on NOT NULL drift).
    ensureSchemaIntegrity(sqlite);
    logger.info("Database ready");

    // ── 5. Auto-generate internal API key ────────────────────────────────────
    // Generated once on first boot; the operator copies it from
    // Settings → Logs → Internal API Key and gives it to Claude for
    // the /beta-logs diagnostic command.
    const existingApiKey = _db
      .select({ value: schema.appConfig.value })
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, "internal_api_key"))
      .get();
    if (!existingApiKey) {
      const newKey = randomBytes(32).toString("hex");
      _db
        .insert(schema.appConfig)
        .values({ key: "internal_api_key", value: newKey, encrypted: true, updatedAt: new Date() })
        .run();
      logger.info("Generated internal API key for diagnostic endpoint");
    }
  }
  return _db;
}

export { schema };
