import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { MCP_REQUEST_ID_HEADER, MCP_TIMING_DEBUG_HEADER, parseMcpRequestId } from "../../../connectors/delegated-mcp/http-diagnostics";

type Phase = "authentication" | "body_read" | "delegation" | "delegation_key" | "signature_verify" | "nonce_claim" | "envelope" | "sdk_connect" | "sdk_dispatch" | "tool_handler" | "response_body" | "cleanup";
type ProtocolPhase = "initialize" | "initialized" | "tool_call" | "other";
const duration = (start: number) => Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);

/** Correlation is untrusted diagnostics only, never identity or authorization.
 * Do not pass requests, errors, bodies, claims or arbitrary metadata to logger.
 */
export function createMcpRequestTiming(request: Request) {
  const started = performance.now();
  const requestId = parseMcpRequestId(request.headers.get(MCP_REQUEST_ID_HEADER)) ?? randomUUID();
  const detailed = request.headers.get(MCP_TIMING_DEBUG_HEADER) === "1";
  const timings = new Map<Phase, number>();
  let protocolPhase: ProtocolPhase = "other";
  const emit = (stage: string, fields: { durationMs?: number; httpStatus?: number; failed?: boolean } = {}, always = false) => {
    if (!always && !detailed) return;
    try { logger.info("MCP_HTTP_TIMING", { requestId, timestampUtc: new Date().toISOString(), stage, protocolPhase, elapsedMs: duration(started), ...fields }); } catch { /* diagnostics cannot alter requests */ }
  };
  const onAbort = () => emit("request_aborted", {}, true);
  request.signal.addEventListener("abort", onAbort, { once: true });
  emit("request_received", {}, true);
  if (request.signal.aborted) onAbort();
  const completePhase = (phase: Phase, phaseStart: number, failed: boolean) => {
    const durationMs = duration(phaseStart);
    timings.set(phase, (timings.get(phase) ?? 0) + durationMs);
    emit(`${phase}_end`, { durationMs, failed });
  };
  return {
    requestId,
    setProtocolPhase(method: string) {
      protocolPhase = method === "initialize" ? "initialize" : method === "notifications/initialized" ? "initialized" : method === "tools/call" ? "tool_call" : "other";
    },
    spanSync<T>(phase: Phase, action: () => T): T {
      const phaseStart = performance.now(); emit(`${phase}_start`);
      let failed = true;
      try { const value = action(); failed = false; return value; }
      finally { completePhase(phase, phaseStart, failed); }
    },
    async span<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
      const phaseStart = performance.now(); emit(`${phase}_start`);
      let failed = true;
      try { const value = await action(); failed = false; return value; }
      finally { completePhase(phase, phaseStart, failed); }
    },
    finish(response: Response): Response {
      request.signal.removeEventListener("abort", onAbort);
      const total = duration(started);
      const headers = new Headers(response.headers);
      headers.set(MCP_REQUEST_ID_HEADER, requestId);
      const metrics = [`mcp_total;dur=${total}`, ...[...timings].map(([phase, ms]) => `mcp_${phase};dur=${Math.round(ms * 1000) / 1000}`)];
      headers.append("Server-Timing", metrics.join(", "));
      emit("request_completed", { durationMs: total, httpStatus: response.status }, true);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    fail() { request.signal.removeEventListener("abort", onAbort); emit("request_failed", {}, true); },
  };
}
export type McpRequestTiming = ReturnType<typeof createMcpRequestTiming>;
