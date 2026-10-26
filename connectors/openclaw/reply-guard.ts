import type { DiagnosticSink } from "../delegated-mcp/diagnostics.js";
import type { OpenClawHost } from "./host.js";

/** Exact-turn presentation guard, never request authorization. Native send +
 * backend presentation acknowledgement must both succeed before it is armed.
 * No session-wide mute, participant identity cache or inference from model text.
 */
export function createPromptReplyGuard<C extends object>(api: OpenClawHost<C>, group: string | undefined, log: DiagnosticSink) {
  const calls = new Map<string, { runId: string; sessionKey: string; expires: number }>();
  const runs = new Map<string, { sessionKey: string; expires: number; mixed: boolean; account?: string; armed: boolean }>();
  const prune = () => {
    for (const map of [calls, runs]) {
      for (const [key, item] of map) if (item.expires <= Date.now()) map.delete(key);
      while (map.size >= 128) map.delete(map.keys().next().value!);
    }
  };
  const clear = () => { calls.clear(); runs.clear(); };
  api.lifecycle.signal?.addEventListener("abort", clear, { once: true });
  if (group && api.registrationMode === "full") {
    api.on("before_tool_call", async (event, context) => {
      prune();
      const { runId, toolCallId, sessionKey } = context;
      if (event.toolName === "thinkarr_media_select" && (!runId || !toolCallId || !sessionKey || context.channelId !== "whatsapp")) {
        log("warn", "presentation.guard_unavailable", { reason: !runId ? "host_run_id_missing" : !toolCallId ? "host_tool_call_id_missing" : !sessionKey ? "host_session_correlation_missing" : "host_tool_channel_mismatch" });
      }
      if (api.lifecycle.signal?.aborted || !runId || !toolCallId || !sessionKey || context.channelId !== "whatsapp"
        || event.toolName !== context.toolName || (event.runId !== undefined && event.runId !== runId)
        || (event.toolCallId !== undefined && event.toolCallId !== toolCallId)) return;
      let run = runs.get(runId);
      if (run && run.sessionKey !== sessionKey) return;
      if (!run) { run = { sessionKey, expires: Date.now() + 120_000, mixed: false, armed: false }; runs.set(runId, run); }
      // Code Mode is a host-discriminated transport for nested calls, not a
      // separate workflow. Its child tools still run all the checks below.
      // A shell tool merely named exec does not receive this exception.
      if (context.toolKind === "code_mode_exec" && event.toolKind === "code_mode_exec") return;
      if (event.toolName === "thinkarr_media_select") {
        calls.set(JSON.stringify([sessionKey, toolCallId]), { runId, sessionKey, expires: run.expires });
        return;
      }
      if (event.toolName === "message") {
        // Outbound message_sending lacks reliable run IDs in this pinned host.
        // Enforce at its tool boundary, where the host supplies exact run/call
        // correlation. Only a text-only send to this same group is redundant.
        const p = event.params;
        const target = typeof p.target === "string" ? p.target.replace(/^whatsapp:/, "") : undefined;
        const rich = ["media", "mediaUrl", "mediaUrls", "filePath", "path", "buffer", "poll", "buttons", "presentation", "interactive"].some((key) => {
          const value = p[key];
          return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
        });
        if (run.armed && !run.mixed && p.action === "send" && target === group
          && p.channel === "whatsapp" && (p.accountId === undefined || p.accountId === run.account)
          && typeof p.message === "string" && !rich) {
          log("info", "presentation.duplicate_tool_blocked");
          return { block: true, blockReason: "Thinkarr already delivered the native confirmation prompt for this turn. Do not send another message. End with NO_REPLY and wait for the participant's native reply." };
        }
        return;
      }
      // Mixed workflows retain their ordinary replies (including finance).
      // Catalog facts alone do not make this a mixed workflow.
      if (!["thinkarr_media_search", "thinkarr_media_details"].includes(event.toolName)) { run.mixed = true; run.armed = false; }
    }, { timeoutMs: 1000 });
    api.on("reply_payload_sending", async (event, context) => {
      prune();
      if (api.lifecycle.signal?.aborted || !event.runId) return;
      const run = runs.get(event.runId);
      if (!run?.armed || run.mixed || event.sessionKey !== run.sessionKey || context.sessionKey !== run.sessionKey
        || context.channelId !== "whatsapp" || event.channel !== "whatsapp" || context.accountId !== run.account
        || context.conversationId?.replace(/^whatsapp:/, "") !== group || event.payload.isError
        || event.payload.isReasoning || event.payload.isCompactionNotice || event.payload.presentation || event.payload.interactive || event.payload.channelData
        || event.payload.mediaUrl || event.payload.mediaUrls?.length || !event.payload.text) return;
      log("info", "presentation.duplicate_reply_cancelled");
      return { cancel: true, reason: "thinkarr_native_prompt_already_delivered" };
    }, { timeoutMs: 1000 });
  }
  return {
    presented(toolCallId: string, sessionKey: string | undefined, account: string) {
      prune(); const key = JSON.stringify([sessionKey, toolCallId]); const call = calls.get(key); calls.delete(key);
      if (!call || !sessionKey || call.sessionKey !== sessionKey || api.lifecycle.signal?.aborted) {
        log("warn", "presentation.guard_unavailable", { reason: "exact_turn_correlation_missing" }); return;
      }
      const run = runs.get(call.runId);
      if (!run || run.mixed || run.sessionKey !== sessionKey) return;
      run.account = account; run.armed = true;
      log("info", "presentation.guard_armed");
    },
  };
}
