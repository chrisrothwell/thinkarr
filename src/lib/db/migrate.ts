import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const DB_PATH = path.join(DB_DIR, "thinkarr.db");

export function runMigrations() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  sqlite.close();
}

if (require.main === module) {
  runMigrations();
  console.log("Migrations complete");
}
