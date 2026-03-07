import { getDb, schema } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";

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

// ---------------------------------------------------------------------------
// Per-user rate limiting
// ---------------------------------------------------------------------------

export type RateLimitPeriod = "hour" | "day" | "week" | "month";

export interface RateLimit {
  messages: number;
  period: RateLimitPeriod;
}

const DEFAULT_RATE_LIMIT: RateLimit = { messages: 100, period: "day" };

export function getRateLimit(userId: number): RateLimit {
  const raw = getConfig(`user.${userId}.rateLimit`);
  if (!raw) return DEFAULT_RATE_LIMIT;
  try {
    return JSON.parse(raw) as RateLimit;
  } catch {
    return DEFAULT_RATE_LIMIT;
  }
}

export function setRateLimit(userId: number, limit: RateLimit): void {
  setConfig(`user.${userId}.rateLimit`, JSON.stringify(limit));
}

/** Start of the current rate-limit window (calendar-aligned). */
export function getPeriodStart(period: RateLimitPeriod): Date {
  const now = new Date();
  switch (period) {
    case "hour":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    case "day":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    case "week": {
      const day = now.getDay(); // 0=Sun … 6=Sat
      const diffToMonday = (day === 0 ? -6 : 1 - day);
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
}

/** Start of the next rate-limit window — shown to the user as the reset time. */
export function getNextPeriodStart(period: RateLimitPeriod): Date {
  const now = new Date();
  switch (period) {
    case "hour":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
    case "day":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    case "week": {
      const start = getPeriodStart("week");
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, 0);
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  }
}

/** Count user-role messages sent by a user since `since`. */
export function countUserMessagesSince(userId: number, since: Date): number {
  const db = getDb();
  const rows = db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
    .where(
      and(
        eq(schema.conversations.userId, userId),
        eq(schema.messages.role, "user"),
        gt(schema.messages.createdAt, since),
      ),
    )
    .all();
  return rows.length;
}
