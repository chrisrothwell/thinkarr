import { eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb, schema } from "@/lib/db";
import { validateServiceUrl } from "@/lib/security/url-validation";
import { resolveServiceActor } from "./account-linking";
import { requireCurrentDelegation, type VerifiedServiceMcpContext } from "./delegation";
import {
  libraryContainer, libraryDetailsInput, librarySearchInput, projectLibraryItem,
  type AvailableLibraryItem, type LibraryDetailsInput, type LibraryMetadata, type LibrarySearchInput, type LibrarySearchResult,
} from "./media-library";

const operations = ["media_search", "media_details", "media_select", "media_pending_selection", "media_confirm_request"] as const;
type MediaOperation = typeof operations[number];
type Failure = "ACTOR_UNAVAILABLE" | "PLEX_SIGN_IN_REQUIRED" | "SERVICE_NOT_CONFIGURED" | "DOWNSTREAM_UNAVAILABLE" | "INVALID_DOWNSTREAM_RESPONSE" | "AMBIGUOUS_SEERR_ACCOUNT" | "EFFECTIVE_USER_MISMATCH" | "INVALID_SELECTION" | "INVALID_QUERY" | "ITEM_UNAVAILABLE";
export class DelegatedMediaAccessError extends Error {
  constructor(public readonly code: Failure) { super("Delegated media access could not be verified."); }
}
const fail = (code: Failure): never => { throw new DelegatedMediaAccessError(code); };
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const plexId = z.union([positive, z.string().regex(/^[1-9][0-9]*$/).max(32)]).transform(String);
const seerrUser = z.object({ id: positive, plexId: plexId.nullish(), userType: positive });
const effectiveUser = seerrUser.extend({ permissions: z.number().int().min(0).max(0x7fffffff) });
const directoryPage = z.object({
  pageInfo: z.object({ results: z.number().int().min(0).max(10_000), pageSize: z.literal(100), pages: z.number().int().min(0), page: positive }),
  results: z.array(seerrUser).max(100),
});
const quota = z.object({
  used: z.number().int().nonnegative(), restricted: z.boolean(),
  limit: z.number().int().nonnegative().optional(), remaining: z.number().int().optional(),
});
const selectionSchema = z.discriminatedUnion("mediaType", [
  z.object({ mediaType: z.literal("movie") }).strict(),
  z.object({ mediaType: z.literal("tv"), seasons: z.array(z.number().int().min(1).max(1000)).min(1).max(100).refine((v) => new Set(v).size === v.length) }).strict(),
]);
export type RequestEligibilitySelection = z.infer<typeof selectionSchema>;
export type RequestEligibility = { eligible: true } | { eligible: false; reason: "seerr_account_required" | "permission" | "quota" };
export type VisibleLibrarySections = { shared: boolean; sections: Array<{ key: string; type: "movie" | "show" }> };

function serviceBase(raw: string | null): string {
  if (!raw || !validateServiceUrl(raw).valid) return fail("SERVICE_NOT_CONFIGURED");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) return fail("SERVICE_NOT_CONFIGURED");
  return url.href.replace(/\/$/, "");
}

function parse<T>(validator: z.ZodType<T>, value: unknown): T {
  const parsed = validator.safeParse(value);
  if (!parsed.success) return fail("INVALID_DOWNSTREAM_RESPONSE");
  return parsed.data;
}

/** Read-only downstream identity/preflight capability. No raw HTTP primitive,
 * actor IDs, keys, tokens, downstream bodies or user directory escape the
 * closure. It is not a media-write authorization or an MCP activation path.
 */
export function createDelegatedMediaAccess(context: VerifiedServiceMcpContext, operation: MediaOperation) {
  let actor: ReturnType<typeof resolveServiceActor>;
  let accountToken: string;
  try {
    if (!operations.includes(operation) || !requireCurrentDelegation(context).allowedOperations.includes(operation)) return fail("ACTOR_UNAVAILABLE");
    actor = resolveServiceActor(context);
    const user = getDb().select().from(schema.users).where(eq(schema.users.id, actor.actorUserId)).get();
    if (!user?.plexToken || !plexId.safeParse(actor.actorPlexId).success) return fail("PLEX_SIGN_IN_REQUIRED");
    accountToken = user.plexToken;
  } catch (error) {
    if (error instanceof DelegatedMediaAccessError) throw error;
    return fail("ACTOR_UNAVAILABLE");
  }
  const settings = Object.freeze({
    plexUrl: getConfig("plex.url"), plexServer: getConfig("plex.clientIdentifier"),
    seerrUrl: getConfig("overseerr.url"), seerrKey: getConfig("overseerr.apiKey"),
  });
  const accountBase = serviceBase(process.env.PLEX_API_BASE ?? "https://plex.tv");
  function assertCurrent() {
    try {
      if (!requireCurrentDelegation(context).allowedOperations.includes(operation)) return fail("ACTOR_UNAVAILABLE");
      const current = resolveServiceActor(context);
      const user = getDb().select().from(schema.users).where(eq(schema.users.id, actor.actorUserId)).get();
      if (current.bindingId !== actor.bindingId || current.bindingVersion !== actor.bindingVersion || current.actorUserId !== actor.actorUserId
        || current.actorPlexId !== actor.actorPlexId || user?.plexToken !== accountToken
        || settings.plexUrl !== getConfig("plex.url") || settings.plexServer !== getConfig("plex.clientIdentifier")
        || settings.seerrUrl !== getConfig("overseerr.url") || settings.seerrKey !== getConfig("overseerr.apiKey")) return fail("ACTOR_UNAVAILABLE");
    } catch { return fail("ACTOR_UNAVAILABLE"); }
  }

  function operationGuard(signal?: AbortSignal) {
    const deadline = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    return {
      signal: deadline,
      check: () => { assertCurrent(); if (deadline.aborted) return fail("DOWNSTREAM_UNAVAILABLE"); },
    };
  }
  type Guard = ReturnType<typeof operationGuard>;
  async function get(url: string, headers: Record<string, string>, guard: Guard, plexAccount = false): Promise<unknown> {
    try {
      guard.check();
      const response = await fetch(url, {
        method: "GET", headers: { Accept: "application/json", ...headers },
        redirect: "error", credentials: "omit", signal: guard.signal,
      });
      guard.check();
      if (response.redirected || (response.status >= 300 && response.status < 400)) return fail("DOWNSTREAM_UNAVAILABLE");
      if (!response.ok) return fail(plexAccount && [401, 403].includes(response.status) ? "PLEX_SIGN_IN_REQUIRED" : "DOWNSTREAM_UNAVAILABLE");
      const reader = response.body?.getReader();
      if (!reader) return fail("INVALID_DOWNSTREAM_RESPONSE");
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read(); guard.check();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 1_048_576) { await reader.cancel(); return fail("INVALID_DOWNSTREAM_RESPONSE"); }
          parts.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      guard.check();
      try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
      catch { return fail("INVALID_DOWNSTREAM_RESPONSE"); }
    } catch (error) {
      if (error instanceof DelegatedMediaAccessError) throw error;
      return fail("DOWNSTREAM_UNAVAILABLE");
    }
  }
  async function verifyPlexAccount(guard: Guard) {
    const user = parse(z.object({ id: plexId }), await get(`${accountBase}/api/v2/user`, { "X-Plex-Token": accountToken }, guard, true));
    if (user.id !== actor.actorPlexId) return fail("PLEX_SIGN_IN_REQUIRED");
  }
  function seerr(guard: Guard, userId?: number) {
    const base = serviceBase(settings.seerrUrl);
    if (!settings.seerrKey) return fail("SERVICE_NOT_CONFIGURED");
    const headers: Record<string, string> = { "X-Api-Key": settings.seerrKey };
    if (userId !== undefined) headers["X-Api-User"] = String(userId);
    return (path: string) => get(`${base}/api/v1${path}`, headers, guard);
  }
  async function findSeerrUser(guard: Guard): Promise<number | undefined> {
    // Full, bounded, stable-ID pagination. No username/email lookup or process
    // cache; a match on an early page cannot hide a duplicate on a later page.
    const directory = seerr(guard);
    let total: number | undefined;
    let previousId = 0;
    let match: number | undefined;
    for (let skip = 0; skip < 10_000; skip += 100) {
      const page = parse(directoryPage, await directory(`/user?take=100&skip=${skip}`));
      if ((total !== undefined && total !== page.pageInfo.results) || page.pageInfo.page !== skip / 100 + 1
        || page.pageInfo.pages !== Math.ceil(page.pageInfo.results / 100)
        || page.results.length !== Math.min(100, page.pageInfo.results - skip)) return fail("INVALID_DOWNSTREAM_RESPONSE");
      total = page.pageInfo.results;
      for (const user of page.results) {
        if (user.id <= previousId) return fail("INVALID_DOWNSTREAM_RESPONSE");
        previousId = user.id;
        if (user.plexId === actor.actorPlexId) {
          if (match !== undefined || user.userType !== 1) return fail("AMBIGUOUS_SEERR_ACCOUNT");
          match = user.id;
        }
      }
      if (skip + page.results.length === total) return match;
    }
    return fail("INVALID_DOWNSTREAM_RESPONSE");
  }

  async function plexLibrary(guard: Guard) {
    guard.check();
    const base = serviceBase(settings.plexUrl);
    if (!settings.plexServer) return fail("SERVICE_NOT_CONFIGURED");
    await verifyPlexAccount(guard);
    const resources = parse(z.array(z.object({
      clientIdentifier: z.string().min(1), provides: z.string(), accessToken: z.string().min(1).optional(),
    })).max(1000), await get(`${accountBase}/api/v2/resources?includeHttps=1&includeRelay=1`, { "X-Plex-Token": accountToken }, guard, true));
    const matches = resources.filter((r) => r.clientIdentifier === settings.plexServer && r.provides.split(",").includes("server"));
    if (matches.length === 0) return { base, headers: {}, shared: false, sections: [] };
    if (matches.length !== 1 || !matches[0].accessToken) return fail("INVALID_DOWNSTREAM_RESPONSE");
    const headers = { "X-Plex-Token": matches[0].accessToken };
    // Resource URLs/connections are never followed. The configured endpoint
    // must prove it is the configured machine under the actor's server token.
    const identity = parse(z.object({ MediaContainer: z.object({ machineIdentifier: z.string() }) }), await get(`${base}/identity`, headers, guard));
    if (identity.MediaContainer.machineIdentifier !== settings.plexServer) return fail("INVALID_DOWNSTREAM_RESPONSE");
    const sections = parse(z.object({ MediaContainer: z.object({
      size: z.number().int().nonnegative().optional(),
      Directory: z.array(z.object({ key: z.union([positive, z.string().regex(/^[1-9][0-9]*$/)]).transform(String), type: z.string() })).optional(),
    }) }), await get(`${base}/library/sections`, headers, guard)).MediaContainer;
    if (!sections.Directory && sections.size !== 0) return fail("INVALID_DOWNSTREAM_RESPONSE");
    const visible = (sections.Directory ?? []).filter((s) => s.type === "movie" || s.type === "show");
    if (new Set(visible.map((s) => s.key)).size !== visible.length) return fail("INVALID_DOWNSTREAM_RESPONSE");
    guard.check();
    if (visible.length > 64) return fail("INVALID_DOWNSTREAM_RESPONSE");
    return { base, headers, shared: true, sections: visible.map((s) => ({ key: s.key, type: s.type as "movie" | "show" })) };
  }
  type PlexLibrary = Awaited<ReturnType<typeof plexLibrary>>;
  function items(value: unknown): { metadata: LibraryMetadata[]; truncated: boolean; sectionId?: string } {
    const container = parse(libraryContainer, value).MediaContainer;
    const metadata = container.Metadata ?? [];
    if (container.size !== metadata.length || (container.totalSize !== undefined && container.totalSize < container.size)) return fail("INVALID_DOWNSTREAM_RESPONSE");
    if (new Set(metadata.map((item) => item.ratingKey)).size !== metadata.length) return fail("INVALID_DOWNSTREAM_RESPONSE");
    return { metadata, truncated: (container.totalSize ?? container.size) > container.size, sectionId: container.librarySectionID };
  }
  async function sectionItems(library: PlexLibrary, section: VisibleLibrarySections["sections"][number], title: string, guard: Guard) {
    const query = new URLSearchParams({ type: section.type === "movie" ? "1" : "2", title,
      "X-Plex-Container-Start": "0", "X-Plex-Container-Size": "21" });
    const result = items(await get(`${library.base}/library/sections/${section.key}/all?${query}`, library.headers, guard));
    if ((result.sectionId !== undefined && result.sectionId !== section.key)
      || result.metadata.some((item) => (item.librarySectionID !== undefined && item.librarySectionID !== section.key) || item.type !== section.type)) return fail("INVALID_DOWNSTREAM_RESPONSE");
    return result;
  }

  return Object.freeze({
    async visibleLibrarySections(signal?: AbortSignal): Promise<VisibleLibrarySections> {
      const guard = operationGuard(signal);
      const library = await plexLibrary(guard);
      guard.check();
      return { shared: library.shared, sections: library.sections };
    },
    async searchLibrary(input: LibrarySearchInput, signal?: AbortSignal): Promise<LibrarySearchResult> {
      if (operation !== "media_search") return fail("ACTOR_UNAVAILABLE");
      const query = librarySearchInput.safeParse(input);
      if (!query.success) return fail("INVALID_QUERY");
      const guard = operationGuard(signal);
      const library = await plexLibrary(guard);
      const found: AvailableLibraryItem[] = [];
      let truncated = false;
      const seen = new Set<string>();
      for (const section of library.sections) {
        if (query.data.mediaType && (query.data.mediaType === "movie" ? "movie" : "show") !== section.type) continue;
        const page = await sectionItems(library, section, query.data.query, guard);
        truncated ||= page.truncated;
        for (const item of page.metadata) {
          if (seen.has(item.ratingKey)) return fail("INVALID_DOWNSTREAM_RESPONSE");
          seen.add(item.ratingKey);
          if (found.length < 20) found.push(projectLibraryItem(item)); else truncated = true;
        }
      }
      guard.check();
      return { items: found, truncated };
    },
    async libraryDetails(input: LibraryDetailsInput, signal?: AbortSignal): Promise<AvailableLibraryItem> {
      if (operation !== "media_details") return fail("ACTOR_UNAVAILABLE");
      const query = libraryDetailsInput.safeParse(input);
      if (!query.success) return fail("INVALID_QUERY");
      const guard = operationGuard(signal);
      const library = await plexLibrary(guard);
      if (!library.shared || library.sections.length === 0) return fail("ITEM_UNAVAILABLE");
      const detail = items(await get(`${library.base}/library/metadata/${query.data.itemId}`, library.headers, guard));
      if (detail.truncated || detail.metadata.length !== 1 || detail.metadata[0].ratingKey !== query.data.itemId) return fail("ITEM_UNAVAILABLE");
      const item = detail.metadata[0];
      if (detail.sectionId && item.librarySectionID && detail.sectionId !== item.librarySectionID) return fail("INVALID_DOWNSTREAM_RESPONSE");
      const section = library.sections.find((s) => s.key === (item.librarySectionID ?? detail.sectionId) && s.type === item.type);
      if (!section) return fail("ITEM_UNAVAILABLE");
      // A guessed direct metadata ID must not bypass Plex's actor-filtered
      // library listing/content restrictions. Independently confirm membership
      // AFTER the detail read, under the same actor token. Bounded ambiguity
      // (e.g. >21 same-title versions) fails closed rather than scanning broadly.
      const membership = await sectionItems(library, section, item.title, guard);
      if (!membership.metadata.some((entry) => entry.ratingKey === item.ratingKey)) return fail("ITEM_UNAVAILABLE");
      guard.check();
      return projectLibraryItem(item);
    },
    async requestEligibility(selection: RequestEligibilitySelection, signal?: AbortSignal): Promise<RequestEligibility> {
      const input = selectionSchema.safeParse(selection);
      if (!input.success) return fail("INVALID_SELECTION");
      const guard = operationGuard(signal);
      guard.check();
      await verifyPlexAccount(guard);
      const id = await findSeerrUser(guard);
      if (id === undefined) return { eligible: false, reason: "seerr_account_required" };
      const effective = seerr(guard, id);
      const user = parse(effectiveUser, await effective("/auth/me"));
      if (user.id !== id || user.plexId !== actor.actorPlexId || user.userType !== 1) return fail("EFFECTIVE_USER_MISMATCH");
      // Seerr's own permission bits; Thinkarr users.isAdmin is never consulted.
      // Approval is deliberately not inferred: the later submission response
      // under this effective user must determine approved vs pending.
      const permission = input.data.mediaType === "movie" ? 262144 : 524288;
      if (!(user.permissions & (2 | 32 | permission))) return { eligible: false, reason: "permission" };
      const quotas = parse(z.object({ movie: quota, tv: quota }), await effective(`/user/${id}/quota`));
      const current = quotas[input.data.mediaType];
      const units = input.data.mediaType === "tv" ? input.data.seasons.length : 1;
      if (current.limit && (current.remaining === undefined || current.remaining > current.limit)) return fail("INVALID_DOWNSTREAM_RESPONSE");
      guard.check();
      if (current.restricted || (current.limit && current.remaining! < units)) return { eligible: false, reason: "quota" };
      return { eligible: true };
    },
  });
}
