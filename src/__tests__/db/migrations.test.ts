import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, isTable } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureSchemaIntegrity } from "@/lib/db";
import path from "path";
import fs from "fs";
import os from "os";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

// Use the real migrator for old releases too: manually executing their SQL
// would hide the timestamp-based skipping that broke the production upgrade.
function migrateThrough(connection: Database.Database, count: number) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "thinkarr-migrations-"));
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, count);
    fs.mkdirSync(path.join(folder, "meta"));
    fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    }
    migrate(drizzle(connection), { migrationsFolder: folder });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

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

  it("upgrades the existing channel schema without changing Plex users or personal token configuration", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    try {
      old.exec("CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
      for (const migration of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).slice(0, 3)) {
        for (const statement of migration.sql) old.exec(statement);
        old.prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)").run(migration.hash, migration.folderMillis);
      }
      old.prepare("INSERT INTO users(plex_id, plex_username, created_at) VALUES ('existing-plex', 'existing-user', 0)").run();
      old.prepare("INSERT INTO app_config(key, value, updated_at) VALUES ('user.1.mcpToken', 'existing-personal-token', 0)").run();
      const db = drizzle(old, { schema });
      migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      expect(db.select().from(schema.users).all()).toHaveLength(1);
      expect(db.select().from(schema.appConfig).get()?.value).toBe("existing-personal-token");
      expect(db.select().from(schema.mcpServicePrincipals).all()).toEqual([]);
      expect(db.select().from(schema.mcpServiceCredentials).all()).toEqual([]);
      expect(db.select().from(schema.mcpServiceKeys).all()).toEqual([]);
      expect(db.select().from(schema.mcpServiceAudit).all()).toEqual([]);
      expect(() => migrate(db, { migrationsFolder: MIGRATIONS_DIR })).not.toThrow();
    } finally { old.close(); }
  });
});

// ---------------------------------------------------------------------------
// Existing production upgrades — 0002 was backdated behind 0000, so the real
// migrator skips it even though later delegated-MCP migrations are applied.
// ---------------------------------------------------------------------------

describe("migrations — legacy channel table repair", () => {
  function seedExistingData(connection: Database.Database) {
    connection.exec(`
      INSERT INTO users (id, plex_id, plex_username, plex_token, created_at)
        VALUES (1, 'existing-plex', 'existing-user', 'existing-plex-token', 0);
      INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('existing-session', 1, 2000000000, 0);
      INSERT INTO app_config (key, value, updated_at) VALUES ('user.1.mcpToken', 'existing-personal-token', 0);
      INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('existing-chat', 1, 'Keep me', 0, 0);
      INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('existing-message', 'existing-chat', 'user', 'Keep my history', 0);
    `);
  }

  function existingData(connection: Database.Database) {
    return Object.fromEntries(["users", "sessions", "app_config", "conversations", "messages"].map(
      (table) => [table, connection.prepare(`SELECT * FROM ${table}`).all()],
    ));
  }

  function assertReady(connection: Database.Database) {
    expect(() => ensureSchemaIntegrity(connection)).not.toThrow();
    const db = drizzle(connection, { schema });
    // Same full-schema probe as /api/health, including every MCP table.
    for (const table of Object.values(schema)) {
      if (isTable(table)) expect(() => db.select().from(table).limit(0).all()).not.toThrow();
    }
    expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(() => migrate(db, { migrationsFolder: MIGRATIONS_DIR })).not.toThrow();
  }

  it.each([1, 2])("upgrades a pre-MCP database with %i historical migrations", (count) => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    try {
      migrateThrough(old, count);
      seedExistingData(old);
      migrate(drizzle(old), { migrationsFolder: MIGRATIONS_DIR });
      // The one-migration case also exercises the existing duration_ms repair.
      assertReady(old);
      expect(old.prepare("SELECT plex_token FROM users").get()).toEqual({ plex_token: "existing-plex-token" });
      expect(old.prepare("SELECT id FROM sessions").get()).toEqual({ id: "existing-session" });
      expect(old.prepare("SELECT value FROM app_config").get()).toEqual({ value: "existing-personal-token" });
      expect(old.prepare("SELECT content FROM messages").get()).toEqual({ content: "Keep my history" });
      expect(old.prepare("SELECT title FROM conversations").get()).toEqual({ title: "Keep me" });
      for (const table of [schema.mcpChannelIdentities, schema.mcpRegistrationTokens, schema.mcpPendingBaskets]) {
        expect(drizzle(old).select().from(table).all()).toEqual([]);
      }
    } finally {
      old.close();
    }
  });

  it.each([false, true])("repairs a failed 1.1.8 upgrade even when 0002 is recorded: %s", (recordSkippedMigration) => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    try {
      migrateThrough(old, 2);
      seedExistingData(old);
      const before = existingData(old);
      migrateThrough(old, 9);
      expect(old.prepare("PRAGMA table_info(mcp_channel_identities)").all()).toEqual([]);
      expect(() => ensureSchemaIntegrity(old)).toThrow(/"mcp_channel_identities"/);
      if (recordSkippedMigration) {
        const skipped = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })[2];
        old.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(skipped.hash, skipped.folderMillis);
      }
      migrate(drizzle(old), { migrationsFolder: MIGRATIONS_DIR });
      assertReady(old);
      expect(existingData(old)).toEqual(before);
    } finally {
      old.close();
    }
  });

  it("preserves existing channel links, registration tokens and pending baskets on a healthy database", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    try {
      migrateThrough(old, 9);
      seedExistingData(old);
      old.exec(`
        INSERT INTO mcp_channel_identities VALUES ('whatsapp', 'existing-actor', 1, 0);
        INSERT INTO mcp_registration_tokens VALUES ('existing-registration', 'whatsapp', 'existing-actor', 2000000000);
        INSERT INTO mcp_pending_baskets VALUES ('existing-basket', '[]', 1, 2000000000);
      `);
      const tables = ["mcp_channel_identities", "mcp_registration_tokens", "mcp_pending_baskets"];
      const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
      migrate(drizzle(old), { migrationsFolder: MIGRATIONS_DIR });
      assertReady(old);
      expect(tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    } finally {
      old.close();
    }
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

  it("throws when an entire table is missing, not just a column (beta incident, 2026-07-27)", () => {
    // mcp_channel_identities never got created on a live beta database even
    // though __drizzle_migrations recorded 0002_mcp_channel_integration as
    // applied. PRAGMA table_info() on a nonexistent table returns zero rows
    // (not an error), so every expected column reads as "missing" — this must
    // still throw exactly like a partial-column drift would, rather than being
    // mistaken for "table has no columns defined" and skipped.
    sqlite.exec("DROP TABLE mcp_channel_identities");

    expect(() => ensureSchemaIntegrity(sqlite)).toThrow(
      /"mcp_channel_identities"\..*is NOT NULL/,
    );
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
