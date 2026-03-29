import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { migrateLlmEndpoints } from "@/lib/db";
import path from "path";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function setEndpoints(endpoints: object[]): void {
  db.insert(schema.appConfig)
    .values({ key: "llm.endpoints", value: JSON.stringify(endpoints), encrypted: false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value: JSON.stringify(endpoints), updatedAt: new Date() },
    })
    .run();
}

function getEndpoints(): object[] {
  const row = db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, "llm.endpoints"))
    .get();
  return row ? JSON.parse(row.value) : [];
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
});

afterEach(() => {
  sqlite.close();
});

describe("migrateLlmEndpoints", () => {
  it("is a no-op when llm.endpoints does not exist", () => {
    migrateLlmEndpoints(db);
    const row = db
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, "llm.endpoints"))
      .get();
    expect(row).toBeUndefined();
  });

  it("is a no-op when all endpoints already have all fields consistent", () => {
    const endpoints = [
      {
        id: "ep1",
        realtimeModel: "gpt-4o-realtime-preview",
        realtimeSystemPrompt: "",
        supportsVoice: true,
        supportsRealtime: true,
      },
    ];
    setEndpoints(endpoints);
    migrateLlmEndpoints(db);
    expect(getEndpoints()).toEqual(endpoints);
  });

  it("sets supportsRealtime=true when realtimeModel is non-empty but supportsRealtime=false", () => {
    setEndpoints([
      {
        id: "ep1",
        realtimeModel: "gpt-4o-realtime-preview",
        realtimeSystemPrompt: "",
        supportsVoice: false,
        supportsRealtime: false,
      },
    ]);
    migrateLlmEndpoints(db);
    const result = getEndpoints() as { supportsRealtime: boolean }[];
    expect(result[0].supportsRealtime).toBe(true);
  });

  it("sets supportsRealtime=false when realtimeModel is empty but supportsRealtime=true", () => {
    setEndpoints([
      {
        id: "ep1",
        realtimeModel: "",
        realtimeSystemPrompt: "",
        supportsVoice: false,
        supportsRealtime: true,
      },
    ]);
    migrateLlmEndpoints(db);
    const result = getEndpoints() as { supportsRealtime: boolean }[];
    expect(result[0].supportsRealtime).toBe(false);
  });

  it("adds missing realtimeModel, realtimeSystemPrompt, supportsVoice, supportsRealtime fields", () => {
    setEndpoints([{ id: "ep1", name: "Default", baseUrl: "http://api.openai.com", model: "gpt-4.1" }]);
    migrateLlmEndpoints(db);
    const result = getEndpoints() as Record<string, unknown>[];
    expect(result[0]).toMatchObject({
      realtimeModel: "",
      realtimeSystemPrompt: "",
      supportsVoice: false,
      supportsRealtime: false,
    });
  });

  it("normalizes multiple endpoints independently", () => {
    setEndpoints([
      { id: "ep1", realtimeModel: "gpt-4o-realtime-preview", supportsRealtime: false },
      { id: "ep2", realtimeModel: "", supportsRealtime: false },
    ]);
    migrateLlmEndpoints(db);
    const result = getEndpoints() as { id: string; supportsRealtime: boolean }[];
    expect(result.find((e) => e.id === "ep1")?.supportsRealtime).toBe(true);
    expect(result.find((e) => e.id === "ep2")?.supportsRealtime).toBe(false);
  });

  it("does not modify unrelated fields", () => {
    setEndpoints([
      {
        id: "ep1",
        name: "MyEndpoint",
        baseUrl: "http://example.com",
        apiKey: "secret",
        model: "gpt-4.1",
        systemPrompt: "custom prompt",
        enabled: true,
        isDefault: true,
        supportsVoice: true,
        supportsRealtime: true,
        realtimeModel: "gpt-4o-realtime-preview",
        realtimeSystemPrompt: "realtime prompt",
      },
    ]);
    migrateLlmEndpoints(db);
    const result = getEndpoints() as Record<string, unknown>[];
    expect(result[0]).toMatchObject({
      name: "MyEndpoint",
      baseUrl: "http://example.com",
      apiKey: "secret",
      model: "gpt-4.1",
      systemPrompt: "custom prompt",
      enabled: true,
      isDefault: true,
    });
  });

  it("handles invalid JSON gracefully without throwing", () => {
    db.insert(schema.appConfig)
      .values({ key: "llm.endpoints", value: "not-valid-json", encrypted: false, updatedAt: new Date() })
      .run();
    expect(() => migrateLlmEndpoints(db)).not.toThrow();
  });
});
