import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import path from "path";
import fs from "fs";
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
 * Exported for unit testing.
 */
export function ensureSchemaIntegrity(sqlite: Database.Database): void {
  type ColRow = { name: string };

  const tables = Object.values(schema).filter(
    (v): v is SQLiteTable => is(v, SQLiteTable),
  );

  for (const table of tables) {
    const tableName = getTableName(table);
    const actual = new Set(
      (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as ColRow[]).map(
        (r) => r.name,
      ),
    );

    for (const col of Object.values(getTableColumns(table))) {
      if (actual.has(col.name)) continue;

      if (col.notNull) {
        // Cannot safely synthesise a backfill value for NOT NULL columns.
        // Crash loudly — the operator must restore the missing migration or
        // manually run the ALTER TABLE SQL before restarting.
        const msg =
          `Schema integrity failure: "${tableName}"."${col.name}" is NOT NULL ` +
          `and cannot be auto-repaired. Check __drizzle_migrations, ensure ` +
          `the migration ran successfully, then restart.`;
        logger.error(msg);
        throw new Error(msg);
      }

      // Nullable column — safe to add; existing rows receive NULL.
      const typeSql = col.getSQLType();
      sqlite.exec(
        `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${typeSql}`,
      );
      logger.warn(
        `Schema drift corrected: added missing nullable column "${col.name}" to "${tableName}"`,
        { tableName, column: col.name, type: typeSql },
      );
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
    logger.info("Database initialized", { path: DB_PATH });

    // Auto-run migrations on first connection
    const migrationsPath = path.join(process.cwd(), "drizzle");
    if (fs.existsSync(migrationsPath)) {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsPath });
      logger.info("Database migrations applied", { migrationsPath });
    }

    // Verify every column in schema.ts exists in the live database.
    // Catches dirty-migration states where __drizzle_migrations records a
    // migration as applied but the ALTER TABLE SQL never ran.
    ensureSchemaIntegrity(sqlite);
  }
  return _db;
}

export { schema };
