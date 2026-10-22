import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getDb, schema } from "@/lib/db";
import { resolveServiceActor } from "./account-linking";
import { consumeDelegatedEvent, requireCurrentDelegation, type VerifiedServiceMcpContext } from "./delegation";
import { createDelegatedMediaAccess } from "./media-access";
import { requirePilotGroup } from "./pilot";
import {
  mediaToolArguments, mediaTools, mediaInputSchema, mediaPresentationArguments, mediaSelectionArguments,
  mediaOutcome, type MediaOutcome,
} from "../../../connectors/delegated-mcp/media-contract";

const selections = schema.mcpMediaSelections;
const empty = z.object({}).strict();
function current(context: VerifiedServiceMcpContext) {
  requirePilotGroup(context);
  const policy = requireCurrentDelegation(context);
  return { ...resolveServiceActor(context), operations: policy.allowedOperations };
}
function argumentsFor(context: VerifiedServiceMcpContext, name: string) {
  const c = context.delegation;
  if (c.source === "tool" && mediaTools.includes(name as typeof mediaTools[number])) return mediaToolArguments[name as typeof mediaTools[number]];
  if (name === "media_select" && c.source === "command" && /^present:[a-f0-9-]{36}$/.test(c.intent ?? "")) return mediaPresentationArguments;
  if (name === "media_confirm_request" && c.source === "message" && ["confirm-current", "confirm-choice"].includes(c.intent ?? "")) return empty;
}
export function serviceMediaTools(context: VerifiedServiceMcpContext): Tool[] {
  try {
    const actor = current(context);
    return [...mediaTools, "media_confirm_request"].flatMap((name) => {
      const args = argumentsFor(context, name);
      return args && actor.operations.includes(name) ? [{
        name, description: name === "media_select" ? "Prepare an exact title/season request prompt for trusted delivery. Does not submit a request."
          : name === "media_confirm_request" ? "Confirm the current delivered prompt using an authenticated incoming message; not a model tool."
            : "Read title facts from the existing Seerr/TMDB catalog. No viewing history, personal request records or global availability is returned.",
        inputSchema: (context.delegation.source === "tool" ? mediaInputSchema(name as typeof mediaTools[number]) : z.toJSONSchema(args)) as Tool["inputSchema"],
        annotations: { readOnlyHint: name === "media_search" || name === "media_details", openWorldHint: true },
      }] : [];
    });
  } catch { return []; }
}
export function authorizeMediaCall(context: VerifiedServiceMcpContext, name: string, args: unknown) {
  if (!serviceMediaTools(context).some((tool) => tool.name === name) || !argumentsFor(context, name)?.safeParse(args).success) throw new Error("Delegated media operation is not permitted.");
  if (name === "media_select" && context.delegation.source === "command") {
    const value = mediaPresentationArguments.parse(args);
    if (context.delegation.intent !== `present:${value.selectionId}`) throw new Error("Invalid presentation.");
  }
}
function outcome(value: MediaOutcome): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(mediaOutcome.parse(value)) }] };
}

export async function callMediaTool(context: VerifiedServiceMcpContext, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  authorizeMediaCall(context, name, args);
  const scoped = () => { const value = current(context); if (!value.operations.includes(name)) throw new Error(); return value; };
  const actor = scoped();
  if (name === "media_search") return outcome({ status: "ok", items: await createDelegatedMediaAccess(context, name).catalogSearch(mediaToolArguments.media_search.parse(args), signal) });
  if (name === "media_details") return outcome({ status: "ok", item: await createDelegatedMediaAccess(context, name).catalogDetails(mediaToolArguments.media_details.parse(args), signal) });
  if (name === "media_select" && context.delegation.source === "tool") {
    const selection = mediaSelectionArguments.parse(args);
    const item = await createDelegatedMediaAccess(context, name).catalogDetails({ id: selection.id, mediaType: selection.mediaType }, signal);
    if (selection.mediaType === "tv" && !selection.seasons.every((s) => item.seasons?.includes(s))) return outcome({ status: "blocked" });
    const id = randomUUID(); const now = Date.now();
    getDb().transaction((tx) => {
      const fresh = scoped();
      if (fresh.bindingId !== actor.bindingId || fresh.bindingVersion !== actor.bindingVersion) throw new Error();
      const previous = tx.select().from(selections).where(and(eq(selections.bindingId, actor.bindingId), inArray(selections.state, ["draft", "pending"]))).get();
      tx.update(selections).set({ state: "superseded" }).where(and(eq(selections.bindingId, actor.bindingId), inArray(selections.state, ["draft", "pending"]))).run();
      tx.insert(selections).values({
        id, bindingId: actor.bindingId, bindingVersion: actor.bindingVersion, userId: actor.actorUserId,
        mediaType: selection.mediaType, mediaId: selection.id, selectionJson: JSON.stringify(selection), state: "draft",
        requiresQuote: !!previous && previous.expiresAt > now, createdAt: now, expiresAt: now + 300_000,
      }).run();
    }, { behavior: "immediate" });
    const title = item.title.replace(/\s+/g, " ");
    const text = `Request ${title}${item.year ? ` (${item.year})` : ""}${selection.mediaType === "tv" ? ` — seasons ${selection.seasons.join(", ")}` : ""}? Reply “request it” within two minutes. If you changed your choice, reply directly to this message.`;
    return { content: [{ type: "text", text: JSON.stringify({ status: "draft" }) }], _meta: { "thinkarr/presentation": { selectionId: id, text } } };
  }
  if (name === "media_select") {
    const value = mediaPresentationArguments.parse(args);
    getDb().transaction((tx) => {
      scoped();
      const updated = tx.update(selections).set({ state: "pending", promptMessageId: value.promptMessageId, presentedAt: Date.now(), expiresAt: Date.now() + 120_000 })
        .where(and(eq(selections.id, value.selectionId), eq(selections.bindingId, actor.bindingId), eq(selections.bindingVersion, actor.bindingVersion), eq(selections.state, "draft"))).returning().get();
      if (!updated || updated.createdAt + 300_000 <= Date.now()) throw new Error("Expired presentation.");
    }, { behavior: "immediate" });
    return outcome({ status: "prompt_sent" });
  }

  // Atomically bind the actual inbound event to one presented, live choice.
  const claim = getDb().transaction((tx) => {
    const fresh = scoped(); const c = context.delegation; const now = Date.now();
    const row = tx.select().from(selections).where(and(eq(selections.bindingId, fresh.bindingId), eq(selections.state, "pending"))).get();
    if (!row) return { status: "unclaimed" as const };
    if (c.requiresQuote && c.replyTo !== row.promptMessageId) return { status: "unclaimed" as const };
    if (row.bindingVersion !== fresh.bindingVersion || row.expiresAt <= now) return { status: "expired" as const };
    if (!row.presentedAt || !c.eventTime || c.eventTime < row.presentedAt
      || (c.replyTo && c.replyTo !== row.promptMessageId) || ((row.requiresQuote || c.requiresQuote) && c.replyTo !== row.promptMessageId)
      || (c.choice !== undefined && c.choice !== 1)) return { status: "reply_to_prompt" as const };
    const unresolved = tx.select().from(selections).where(and(eq(selections.userId, fresh.actorUserId), eq(selections.mediaType, row.mediaType), eq(selections.mediaId, row.mediaId), inArray(selections.state, ["submitting", "unknown"]))).get();
    if (unresolved) return { status: "unknown" as const };
    consumeDelegatedEvent(context, tx);
    tx.update(selections).set({ state: "submitting" }).where(and(eq(selections.id, row.id), eq(selections.state, "pending"))).run();
    return { row };
  }, { behavior: "immediate" });
  const row = claim.row;
  if (!row) return outcome({ status: claim.status ?? "failed" });
  let attempted = false;
  let status: "submitted" | "pending_approval" | "blocked" | "unknown" | "failed";
  try {
    const access = createDelegatedMediaAccess(context, "media_confirm_request");
    status = await access.submitConfirmedRequest(mediaSelectionArguments.parse(JSON.parse(row.selectionJson)), () => {
      scoped();
      attempted = true;
      getDb().update(selections).set({ state: "unknown" }).where(eq(selections.id, row.id)).run();
    }, signal);
    scoped();
  } catch { status = attempted ? "unknown" : "failed"; }
  getDb().update(selections).set({ state: status === "unknown" ? "unknown" : ["submitted", "pending_approval"].includes(status) ? "completed" : "failed", outcome: status }).where(eq(selections.id, row.id)).run();
  return outcome({ status });
}
