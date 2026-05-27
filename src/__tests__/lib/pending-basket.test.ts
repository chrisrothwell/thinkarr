import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingItem } from "@/lib/tools/pending-basket";

const ITEMS: PendingItem[] = [
  { overseerrId: 1, mediaType: "movie", title: "Alien" },
  { overseerrId: 2, mediaType: "tv", seasonNumber: 1, title: "Off Campus — Season 1" },
];

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn().mockReturnValue({ where: () => ({ run: mockRun }) });

let insertedRow: { token: string; itemsJson: string; userId: number; expiresAt: number } | null = null;

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: typeof insertedRow) => {
        insertedRow = v;
        return { run: vi.fn() };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ get: mockGet }),
      }),
    }),
    delete: mockDelete,
  }),
  schema: {
    mcpPendingBaskets: { token: "token", userId: "user_id", expiresAt: "expires_at" },
  },
}));

vi.mock("crypto", () => ({
  randomBytes: () => ({ toString: () => "a".repeat(64) }),
}));

describe("pending-basket", () => {
  beforeEach(() => {
    insertedRow = null;
    mockGet.mockReset();
    mockRun.mockReset();
    vi.resetModules();
  });

  it("createBasket stores items and returns a hex token", async () => {
    const { createBasket } = await import("@/lib/tools/pending-basket");
    const token = createBasket(ITEMS, 42);
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(64);
    expect(insertedRow).not.toBeNull();
    expect(JSON.parse(insertedRow!.itemsJson)).toEqual(ITEMS);
    expect(insertedRow!.userId).toBe(42);
    expect(insertedRow!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("resolveBasket returns the correct item and deletes the row", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockGet.mockReturnValue({
      token: "abc",
      itemsJson: JSON.stringify(ITEMS),
      userId: 42,
      expiresAt: now + 600,
    });
    const { resolveBasket } = await import("@/lib/tools/pending-basket");
    const item = resolveBasket("abc", 2, 42);
    expect(item).toEqual(ITEMS[1]);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("resolveBasket returns null for expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockGet.mockReturnValue({
      token: "abc",
      itemsJson: JSON.stringify(ITEMS),
      userId: 42,
      expiresAt: now - 1,
    });
    const { resolveBasket } = await import("@/lib/tools/pending-basket");
    expect(resolveBasket("abc", 1, 42)).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("resolveBasket returns null for wrong user", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockGet.mockReturnValue({
      token: "abc",
      itemsJson: JSON.stringify(ITEMS),
      userId: 99,
      expiresAt: now + 600,
    });
    const { resolveBasket } = await import("@/lib/tools/pending-basket");
    expect(resolveBasket("abc", 1, 42)).toBeNull();
  });

  it("resolveBasket returns null for out-of-range selection", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockGet.mockReturnValue({
      token: "abc",
      itemsJson: JSON.stringify(ITEMS),
      userId: 42,
      expiresAt: now + 600,
    });
    const { resolveBasket } = await import("@/lib/tools/pending-basket");
    expect(resolveBasket("abc", 99, 42)).toBeNull();
  });

  it("resolveBasket returns null when row not found", async () => {
    mockGet.mockReturnValue(undefined);
    const { resolveBasket } = await import("@/lib/tools/pending-basket");
    expect(resolveBasket("missing", 1, 42)).toBeNull();
  });
});
