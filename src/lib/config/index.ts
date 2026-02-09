import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export function getConfig(key: string): string | null {
  const db = getDb();
  const row = db.select().from(schema.appConfig).where(eq(schema.appConfig.key, key)).get();
  return row?.value ?? null;
}

export function setConfig(key: string, value: string, encrypted = false): void {
  const db = getDb();
  db.insert(schema.appConfig)
    .values({ key, value, encrypted, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value, encrypted, updatedAt: new Date() },
    })
    .run();
}

export function getConfigMap(keys: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = getConfig(key);
  }
  return result;
}

export function isSetupComplete(): boolean {
  return getConfig("setup.complete") === "true";
}
