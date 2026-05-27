import { randomBytes } from "crypto";
import { getDb, schema } from "@/lib/db";
import { eq, lt, and } from "drizzle-orm";

export interface PendingItem {
  overseerrId: number;
  mediaType: "movie" | "tv";
  seasonNumber?: number;
  title: string;
}

/** Store a list of requestable items for a user, returning a one-time token. TTL: 10 min. */
export function createBasket(items: PendingItem[], userId: number): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const db = getDb();
  db.insert(schema.mcpPendingBaskets)
    .values({ token, itemsJson: JSON.stringify(items), userId, expiresAt })
    .run();
  return token;
}

/**
 * Resolve a basket token + 1-based selection to a PendingItem.
 * Returns null if the token is invalid, expired, wrong user, or the selection is out of range.
 * Deletes the basket on a successful resolution (one-time use).
 */
export function resolveBasket(
  token: string,
  selection: number,
  userId: number,
): PendingItem | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db
    .select()
    .from(schema.mcpPendingBaskets)
    .where(
      and(
        eq(schema.mcpPendingBaskets.token, token),
        eq(schema.mcpPendingBaskets.userId, userId),
      ),
    )
    .get();

  if (!row || row.expiresAt < now) return null;

  const items: PendingItem[] = JSON.parse(row.itemsJson);
  const item = items[selection - 1];
  if (!item) return null;

  db.delete(schema.mcpPendingBaskets)
    .where(eq(schema.mcpPendingBaskets.token, token))
    .run();

  return item;
}

export function cleanExpiredBaskets(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.delete(schema.mcpPendingBaskets)
    .where(lt(schema.mcpPendingBaskets.expiresAt, now))
    .run();
}
