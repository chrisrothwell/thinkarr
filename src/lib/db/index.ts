import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

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

    // Auto-run migrations on first connection
    const migrationsPath = path.join(process.cwd(), "drizzle");
    if (fs.existsSync(migrationsPath)) {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsPath });
    }
  }
  return _db;
}

export { schema };
