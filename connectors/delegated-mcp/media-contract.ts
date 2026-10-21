import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seasons = z.array(z.number().int().min(1).max(1000)).min(1).max(100).refine((v) => new Set(v).size === v.length);
export const mediaSearchArguments = z.object({ query: z.string().trim().min(1).max(160) }).strict();
export const mediaDetailsArguments = z.object({ id, mediaType: z.enum(["movie", "tv"]) }).strict();
export const mediaSelectionArguments = z.discriminatedUnion("mediaType", [
  z.object({ id, mediaType: z.literal("movie") }).strict(),
  z.object({ id, mediaType: z.literal("tv"), seasons }).strict(),
]);
export type MediaSelection = z.infer<typeof mediaSelectionArguments>;
export const mediaPresentationArguments = z.object({ selectionId: z.string().uuid(), promptMessageId: z.string().min(1).max(512) }).strict();
export const catalogItem = z.object({
  id, mediaType: z.enum(["movie", "tv"]), title: z.string().min(1).max(300),
  year: z.number().int().min(1800).max(9999).optional(), synopsis: z.string().max(1000).optional(),
  rating: z.number().min(0).max(10).optional(),
  cast: z.array(z.string().min(1).max(200)).max(8).optional(),
  genres: z.array(z.string().min(1).max(100)).max(10).optional(),
  seasons: z.array(z.number().int().min(1).max(1000)).max(100).optional(),
}).strict();
export const mediaOutcome = z.union([
  z.object({ status: z.literal("ok"), items: z.array(catalogItem).max(5) }).strict(),
  z.object({ status: z.literal("ok"), item: catalogItem }).strict(),
  z.object({ status: z.enum(["prompt_sent", "submitted", "pending_approval", "unclaimed", "expired", "reply_to_prompt", "blocked", "unknown", "failed"]) }).strict(),
]);
export type MediaOutcome = z.infer<typeof mediaOutcome>;
export const presentation = z.object({ selectionId: z.string().uuid(), text: z.string().min(1).max(2000) }).strict();
export const mediaTools = ["media_search", "media_details", "media_select"] as const;
export type MediaTool = typeof mediaTools[number];
export const mediaToolArguments = { media_search: mediaSearchArguments, media_details: mediaDetailsArguments, media_select: mediaSelectionArguments };
export function mediaInputSchema(name: MediaTool) {
  return name === "media_search"
    ? { type: "object" as const, properties: { query: { type: "string", minLength: 1, maxLength: 160 } }, required: ["query"], additionalProperties: false as const }
    : { type: "object" as const, properties: {
      id: { type: "integer", minimum: 1 }, mediaType: { type: "string", enum: ["movie", "tv"] },
      ...(name === "media_select" ? { seasons: { type: "array", items: { type: "integer", minimum: 1, maximum: 1000 }, minItems: 1, maxItems: 100, uniqueItems: true } } : {}),
    }, required: ["id", "mediaType"], additionalProperties: false as const };
}

/** Only actual, admitted inbound text may choose a confirmation intent. */
export function confirmationIntent(content: string, replyTo?: string) {
  if (typeof content !== "string" || content.length > 80) return;
  const text = content.trim().toLowerCase();
  if (/^request it(?: please)?$/.test(text)) return { source: "message" as const, intent: "confirm-current", ...(replyTo ? { replyTo } : {}) };
  const choice = /^request ([1-9][0-9]?)(?: please)?$/.exec(text);
  if (choice) return { source: "message" as const, intent: "confirm-choice", choice: Number(choice[1]), ...(replyTo ? { replyTo } : {}) };
  if (replyTo && /^yes(?: please)?$/.test(text)) return { source: "message" as const, intent: "confirm-current", replyTo, requiresQuote: true };
}
