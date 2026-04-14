/**
 * Unit tests for radarr.ts — searchMovie library-only search (issue #361).
 *
 * /movie/lookup returns external TMDB results with no `id` and unreliable
 * monitored/hasFile values. searchMovie now queries /movie (library-only)
 * and filters client-side by title substring or exact 4-digit year.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ getConfig: vi.fn((key: string) => (key === "radarr.url" ? "http://radarr" : "apikey")) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const FAKE_LIBRARY = [
  { id: 1, title: "Dune: Part Two", year: 2024, status: "released", monitored: true, hasFile: true, tmdbId: 111 },
  { id: 2, title: "Dune (1984)", year: 1984, status: "released", monitored: false, hasFile: true, tmdbId: 222 },
  { id: 3, title: "Send Help", year: 2026, status: "released", monitored: true, hasFile: true, tmdbId: 333 },
  { id: 4, title: "The Caretaker", year: 2026, status: "inCinemas", monitored: true, hasFile: false, tmdbId: 444 },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if ((url as string).includes("/movie/lookup")) throw new Error("lookup endpoint must not be called");
      const match = FAKE_LIBRARY.find((m) => (url as string).endsWith(`/movie/${m.id}`));
      return { ok: true, status: 200, json: async () => match ?? FAKE_LIBRARY };
    }),
  );
});

import { searchMovie } from "@/lib/services/radarr";

describe("searchMovie — searches library only, never /movie/lookup (issue #361)", () => {
  it("returns library entries matching title substring", async () => {
    const results = await searchMovie("Dune");
    expect(results.map((r) => r.title)).toEqual(["Dune: Part Two", "Dune (1984)"]);
  });

  it("matches by year when a 4-digit year term is given", async () => {
    const results = await searchMovie("2026");
    expect(results.map((r) => r.title)).toEqual(["Send Help", "The Caretaker"]);
  });

  it("returns empty array when no library movies match", async () => {
    const results = await searchMovie("Inception");
    expect(results).toHaveLength(0);
  });

  it("all results have an id (library entries only)", async () => {
    const results = await searchMovie("Dune");
    expect(results.every((r) => r.id !== undefined)).toBe(true);
  });
});
