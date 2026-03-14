import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates an in-memory SQLite database with all migrations applied.
 * Call sqlite.close() in afterEach.
 */
export function createTestDb(): { db: TestDb; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, sqlite };
}

/** Insert a user and return their auto-incremented id. */
export function seedUser(
  db: TestDb,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): number {
  const result = db
    .insert(schema.users)
    .values({
      plexId: `plex-${Math.random().toString(36).slice(2)}`,
      plexUsername: "testuser",
      plexEmail: "test@example.com",
      isAdmin: false,
      createdAt: new Date(),
      ...overrides,
    })
    .run();
  return Number(result.lastInsertRowid);
}

/** Insert a valid session for a user and return the session id. */
export function seedSession(db: TestDb, userId: number): string {
  const sessionId = `session-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.sessions)
    .values({
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    })
    .run();
  return sessionId;
}

/** Insert a conversation and return its id. */
export function seedConversation(
  db: TestDb,
  userId: number,
  title = "Test Chat",
): string {
  const id = `conv-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  db.insert(schema.conversations)
    .values({ id, userId, title, createdAt: now, updatedAt: now })
    .run();
  return id;
}
