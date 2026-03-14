import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

type Col = { name: string; notnull: number; pk: number; dflt_value: string | null };

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Schema structure
// ---------------------------------------------------------------------------

describe("schema — tables exist", () => {
  it("creates all required tables", () => {
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("app_config");
    expect(names).toContain("conversations");
    expect(names).toContain("messages");
    expect(names).toContain("sessions");
    expect(names).toContain("users");
  });
});

describe("schema — column definitions", () => {
  function cols(table: string): Record<string, Col> {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Col[];
    return Object.fromEntries(rows.map((c) => [c.name, c]));
  }

  it("users has correct columns", () => {
    const c = cols("users");
    expect(c["id"].pk).toBe(1);
    expect(c["plex_id"].notnull).toBe(1);
    expect(c["plex_username"].notnull).toBe(1);
    expect(c).toHaveProperty("plex_email");
    expect(c).toHaveProperty("plex_avatar_url");
    expect(c).toHaveProperty("plex_token");
    expect(c).toHaveProperty("is_admin");
    expect(c).toHaveProperty("created_at");
  });

  it("sessions has correct columns", () => {
    const c = cols("sessions");
    expect(c["id"].pk).toBe(1);
    expect(c["user_id"].notnull).toBe(1);
    expect(c["expires_at"].notnull).toBe(1);
    expect(c).toHaveProperty("created_at");
  });

  it("conversations has correct columns", () => {
    const c = cols("conversations");
    expect(c["id"].pk).toBe(1);
    expect(c["user_id"].notnull).toBe(1);
    expect(c).toHaveProperty("title");
    expect(c).toHaveProperty("created_at");
    expect(c).toHaveProperty("updated_at");
  });

  it("messages has correct columns", () => {
    const c = cols("messages");
    expect(c["id"].pk).toBe(1);
    expect(c["conversation_id"].notnull).toBe(1);
    expect(c["role"].notnull).toBe(1);
    expect(c).toHaveProperty("content");
    expect(c).toHaveProperty("tool_calls");
    expect(c).toHaveProperty("tool_call_id");
    expect(c).toHaveProperty("tool_name");
    expect(c).toHaveProperty("created_at");
  });

  it("app_config has correct columns", () => {
    const c = cols("app_config");
    expect(c["key"].pk).toBe(1);
    expect(c["value"].notnull).toBe(1);
    expect(c).toHaveProperty("encrypted");
    expect(c).toHaveProperty("updated_at");
  });
});

// ---------------------------------------------------------------------------
// Constraints and indexes
// ---------------------------------------------------------------------------

describe("schema — constraints", () => {
  it("enforces unique constraint on users.plex_id", () => {
    sqlite
      .prepare(
        "INSERT INTO users (plex_id, plex_username, created_at) VALUES ('dup', 'u1', 0)",
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO users (plex_id, plex_username, created_at) VALUES ('dup', 'u2', 0)",
        )
        .run(),
    ).toThrow();
  });

  it("cascades user delete to conversations", () => {
    const uid = sqlite
      .prepare("INSERT INTO users (plex_id, plex_username, created_at) VALUES ('u1','u1',0)")
      .run().lastInsertRowid;
    sqlite
      .prepare(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ('c1',?,0,0)",
      )
      .run(uid);
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(uid);
    const conv = sqlite.prepare("SELECT * FROM conversations WHERE id='c1'").get();
    expect(conv).toBeUndefined();
  });

  it("cascades conversation delete to messages", () => {
    const uid = sqlite
      .prepare("INSERT INTO users (plex_id, plex_username, created_at) VALUES ('u2','u2',0)")
      .run().lastInsertRowid;
    sqlite
      .prepare(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ('c2',?,0,0)",
      )
      .run(uid);
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, created_at) VALUES ('m1','c2','user',0)",
      )
      .run();
    sqlite.prepare("DELETE FROM conversations WHERE id='c2'").run();
    const msg = sqlite.prepare("SELECT * FROM messages WHERE id='m1'").get();
    expect(msg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("migrations — idempotency", () => {
  it("can be applied twice without error", () => {
    const db = drizzle(sqlite, { schema });
    expect(() => migrate(db, { migrationsFolder: MIGRATIONS_DIR })).not.toThrow();
  });
});
