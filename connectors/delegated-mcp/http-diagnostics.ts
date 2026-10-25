import type { DiagnosticFields, DiagnosticSink } from "./diagnostics.js";

export const MCP_REQUEST_ID_HEADER = "X-Thinkarr-Request-Id";
export const MCP_TIMING_DEBUG_HEADER = "X-Thinkarr-Debug-Timing";
export function parseMcpRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}
export function readMcpServerDuration(value: string | null): number | undefined {
  if (!value || value.length > 4096) return;
  const match = /(?:^|,)\s*mcp_total;dur=(\d{1,8}(?:\.\d{1,3})?)\s*(?=,|$)/.exec(value);
  const duration = match ? Number(match[1]) : NaN;
  return Number.isFinite(duration) && duration >= 0 && duration <= 86_400_000 ? duration : undefined;
}

/** Observe SDK body consumption without cloning, eager draining or buffering.
 * Preserve native response metadata/method receivers. SSE reads stay pull-based.
 */
export function observeMcpResponse(response: Response, log: DiagnosticSink, fields: DiagnosticFields): Response {
  const receivedAt = performance.now();
  let finished = false;
  let begun = false;
  const begin = () => {
    if (begun || finished) return;
    begun = true;
    try { log("debug", "mcp.http.body_start", { ...fields, bodyDurationMs: performance.now() - receivedAt }); } catch { /* preserve body consumption */ }
  };
  const finish = (stage: "mcp.http.body_complete" | "mcp.http.body_error" | "mcp.http.body_cancelled") => {
    if (finished) return;
    finished = true;
    try { log(stage === "mcp.http.body_error" ? "error" : "debug", stage, { ...fields, bodyDurationMs: performance.now() - receivedAt }); } catch { /* preserve body consumption */ }
  };
  if (!response.body) { finish("mcp.http.body_complete"); return response; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        begin();
        reader ??= response.body!.getReader();
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); finish("mcp.http.body_complete"); }
        else controller.enqueue(next.value);
      } catch (error) { finish("mcp.http.body_error"); controller.error(error); }
    },
    async cancel(reason) {
      finish("mcp.http.body_cancelled");
      if (reader) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
      else await response.body!.cancel(reason);
    },
  }, { highWaterMark: 0 });
  const readers = new Set(["text", "json", "arrayBuffer", "blob", "formData", "bytes"]);
  return new Proxy(response, {
    get(target, property) {
      if (property === "body") return body;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "clone") return () => {
        if (body.locked) throw new TypeError("Response body is locked");
        return value.call(target);
      };
      if (typeof property === "string" && readers.has(property)) return async (...args: unknown[]) => {
        try {
          begin();
          if (body.locked) throw new TypeError("Response body is locked");
          const result = await Reflect.apply(value, target, args);
          finish("mcp.http.body_complete"); return result;
        } catch (error) { finish("mcp.http.body_error"); throw error; }
      };
      return value.bind(target);
    },
  });
}
