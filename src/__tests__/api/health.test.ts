import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let sqlite: Database.Database;
vi.mock("@/lib/db", () => ({ getDb: () => db }));
import { GET } from "@/app/api/health/route";

beforeEach(() => { ({ db, sqlite } = createTestDb()); });
afterEach(() => sqlite.close());

describe("production schema health probe", () => {
  it("reports healthy for an intact empty database without requiring configured services", async () => {
    const response = await GET(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
  it.each(["mcp_media_selections", "mcp_actor_bindings", "mcp_service_keys"])("fails closed without exposing database errors when %s is absent", async (table) => {
    sqlite.exec(`DROP TABLE ${table}`);
    const response = await GET(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
  });
  it("detects a missing delegated-request column, not just a missing table", async () => {
    sqlite.exec("ALTER TABLE mcp_media_selections DROP COLUMN outcome");
    const response = await GET(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
  });
});
