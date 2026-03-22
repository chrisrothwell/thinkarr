import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import path from "path";
import fs from "fs";
import { logger } from "@/lib/logger";

const DB_DIR = process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const DB_PATH = path.join(DB_DIR, "thinkarr.db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

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

    // Defensive column check: ensure duration_ms exists on messages even if the
    // migration tracker recorded it as applied but the ALTER TABLE never ran
    // (e.g. due to a crash or a DB restored from backup taken before the column existed).
    type ColRow = { name: string };
    const cols = sqlite.prepare("PRAGMA table_info(messages)").all() as ColRow[];
    if (!cols.some((c) => c.name === "duration_ms")) {
      sqlite.exec("ALTER TABLE messages ADD COLUMN duration_ms INTEGER");
      logger.warn("duration_ms column was missing from messages — added via fallback", { path: DB_PATH });
    }
  }
  return _db;
}

export { schema };
