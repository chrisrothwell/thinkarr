import { z } from "zod";

const itemId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]*$/).max(32)]).transform(String);
const text = (max: number) => z.string().trim().min(1).max(max);
export const librarySearchInput = z.object({ query: text(160), mediaType: z.enum(["movie", "tv"]).optional() }).strict();
export const libraryDetailsInput = z.object({ itemId: z.string().regex(/^[1-9][0-9]*$/).max(32) }).strict();
export type LibrarySearchInput = z.infer<typeof librarySearchInput>;
export type LibraryDetailsInput = z.infer<typeof libraryDetailsInput>;

// Unknown fields are deliberately stripped at every level. These are catalog
// facts, not the legacy mapper's viewing/added/request/file/thumbnail fields.
export const libraryMetadata = z.object({
  ratingKey: itemId, librarySectionID: itemId.optional(), type: z.enum(["movie", "show"]), title: text(300),
  year: z.number().int().min(1800).max(9999).optional(), summary: z.string().max(20_000).optional(),
  rating: z.number().min(0).max(10).optional(),
  Genre: z.array(z.object({ tag: text(100) })).max(100).optional(),
  Role: z.array(z.object({ tag: text(200) })).max(1000).optional(),
});
export type LibraryMetadata = z.infer<typeof libraryMetadata>;
export const libraryContainer = z.object({ MediaContainer: z.object({
  size: z.number().int().nonnegative(),
  totalSize: z.number().int().nonnegative().optional(),
  offset: z.literal(0).optional(),
  librarySectionID: itemId.optional(),
  Metadata: z.array(libraryMetadata).max(21).optional(),
}) });

export type AvailableLibraryItem = {
  itemId: string; mediaType: "movie" | "tv"; title: string; year?: number;
  synopsis?: string; genres: string[]; cast: string[]; rating?: number;
  availability: "available";
};
export type LibrarySearchResult = { items: AvailableLibraryItem[]; truncated: boolean };

export function projectLibraryItem(item: LibraryMetadata): AvailableLibraryItem {
  // Construct, never spread: arbitrary nested catalog/user/media objects cannot
  // survive this boundary. IDs are numeric lookup handles, not fetch paths or
  // authority; every details lookup re-establishes actor-filtered membership.
  return {
    itemId: item.ratingKey, mediaType: item.type === "show" ? "tv" : "movie", title: item.title,
    ...(item.year !== undefined ? { year: item.year } : {}),
    ...(item.summary ? { synopsis: item.summary.slice(0, 1000) } : {}),
    ...(item.rating !== undefined ? { rating: item.rating } : {}),
    genres: (item.Genre ?? []).slice(0, 10).map((g) => g.tag),
    cast: (item.Role ?? []).slice(0, 8).map((r) => r.tag),
    availability: "available",
  };
}
