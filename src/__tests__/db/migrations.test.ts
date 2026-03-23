import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureSchemaIntegrity } from "@/lib/db";
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
    expect(c).toHaveProperty("duration_ms");
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

// ---------------------------------------------------------------------------
// ensureSchemaIntegrity — generic schema drift correction
//
// Tests for the exported ensureSchemaIntegrity() function, which replaced the
// hardcoded duration_ms fallback. It works for ANY nullable column in ANY
// table — not just duration_ms.
//
// Requires SQLite >= 3.35.0 for ALTER TABLE DROP COLUMN, which better-sqlite3
// v12 provides via its bundled SQLite.
// ---------------------------------------------------------------------------

describe("ensureSchemaIntegrity — generic drift correction", () => {
  it("is a no-op when the live schema matches schema.ts", () => {
    // Fresh DB with all migrations applied — nothing should change.
    expect(() => ensureSchemaIntegrity(sqlite)).not.toThrow();
  });

  it("automatically adds any missing nullable column (not just duration_ms)", () => {
    sqlite.exec("ALTER TABLE messages DROP COLUMN duration_ms");

    type ColRow = { name: string };
    const before = sqlite.prepare("PRAGMA table_info(messages)").all() as ColRow[];
    expect(before.some((c) => c.name === "duration_ms")).toBe(false);

    expect(() => ensureSchemaIntegrity(sqlite)).not.toThrow();

    const after = sqlite.prepare("PRAGMA table_info(messages)").all() as ColRow[];
    expect(after.some((c) => c.name === "duration_ms")).toBe(true);
  });

  it("throws for a missing NOT NULL column — cannot safely backfill without the migration SQL", () => {
    // Drop a NOT NULL column (messages.role). The correct backfill value for
    // existing rows cannot be inferred at runtime — ensureSchemaIntegrity
    // must crash loudly so the operator knows to intervene.
    sqlite.exec("ALTER TABLE messages DROP COLUMN role");

    expect(() => ensureSchemaIntegrity(sqlite)).toThrow(/NOT NULL/);
  });
});

// ---------------------------------------------------------------------------
// ensureSchemaIntegrity — full production dirty-migration chain (issue #134)
//
// Proves the exact failure sequence that caused the production outage:
//   1. All migrations ran — correct hashes in __drizzle_migrations
//   2. DB file replaced with a pre-migration backup — column absent
//   3. migrate() skips 0001 — it is already in __drizzle_migrations
//   4. ensureSchemaIntegrity() detects the gap and auto-repairs the column
//   5. Health-probe SELECT (mirrors GET /api/health) succeeds
// ---------------------------------------------------------------------------

describe("ensureSchemaIntegrity — full dirty-migration chain", () => {
  it("recovers when migrate() skips a tracked-but-unapplied migration", () => {
    const dirtySqlite = new Database(":memory:");
    dirtySqlite.pragma("foreign_keys = ON");
    const db = drizzle(dirtySqlite, { schema });

    // 1. Apply all migrations — drizzle writes real content-hashes to __drizzle_migrations.
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    type ColRow = { name: string };
    expect(
      (dirtySqlite.prepare("PRAGMA table_info(messages)").all() as ColRow[]).some(
        (c) => c.name === "duration_ms",
      ),
    ).toBe(true);

    // 2. Drop the column — simulates a backup-restore dirty state.
    dirtySqlite.exec("ALTER TABLE messages DROP COLUMN duration_ms");

    // 3. Re-run migrate() — must skip 0001 (hash is in __drizzle_migrations).
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(
      (dirtySqlite.prepare("PRAGMA table_info(messages)").all() as ColRow[]).some(
        (c) => c.name === "duration_ms",
      ),
      "migrate() must NOT restore the column — confirms ensureSchemaIntegrity is needed",
    ).toBe(false);

    // 4. ensureSchemaIntegrity detects and repairs the gap.
    expect(() => ensureSchemaIntegrity(dirtySqlite)).not.toThrow();

    // 5. Health-probe SELECT succeeds.
    expect(() =>
      drizzle(dirtySqlite, { schema }).select().from(schema.messages).limit(0).all(),
    ).not.toThrow();

    dirtySqlite.close();
  });
});

// ---------------------------------------------------------------------------
// Schema-migration parity: Drizzle ORM round-trip
//
// These tests INSERT and SELECT via the Drizzle schema (not raw SQL) so that
// any column present in schema.ts but absent from the migration files causes
// an immediate SQLite "no column named X" failure rather than a silent gap.
// This is exactly the class of bug that caused issue #134 (duration_ms added
// to schema.ts without a corresponding ALTER TABLE migration).
// ---------------------------------------------------------------------------

describe("schema-migration parity — Drizzle round-trip", () => {
  function seedParents(): { uid: bigint | number; convId: string } {
    const uid = sqlite
      .prepare("INSERT INTO users (plex_id, plex_username, created_at) VALUES ('rt_u','rt_u',0)")
      .run().lastInsertRowid;
    sqlite
      .prepare("INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ('rt_c',?,0,0)")
      .run(uid);
    return { uid, convId: "rt_c" };
  }

  it("can insert and read back a message with all schema fields including duration_ms", () => {
    const db = drizzle(sqlite, { schema });
    const { convId } = seedParents();

    // If duration_ms (or any other field) is in schema.ts but not in a migration,
    // this insert will throw: "table messages has no column named duration_ms"
    expect(() =>
      db
        .insert(schema.messages)
        .values({
          id: "rt_m1",
          conversationId: convId,
          role: "tool",
          content: "result",
          toolCalls: null,
          toolCallId: "tc_1",
          toolName: "plex_search",
          durationMs: 1234,
        })
        .run(),
    ).not.toThrow();

    const row = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, "rt_m1"))
      .get();
    expect(row?.durationMs).toBe(1234);
  });

  it("duration_ms defaults to null when not provided", () => {
    const db = drizzle(sqlite, { schema });
    const { convId } = seedParents();

    db
      .insert(schema.messages)
      .values({ id: "rt_m2", conversationId: convId, role: "user", content: "hello" })
      .run();

    const row = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, "rt_m2"))
      .get();
    expect(row?.durationMs).toBeNull();
  });
});
