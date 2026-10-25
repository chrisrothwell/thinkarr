import { describe, expect, it, vi } from "vitest";
import { observeMcpResponse, parseMcpRequestId, readMcpServerDuration } from "../../../connectors/delegated-mcp/http-diagnostics";

describe("MCP response timing observer", () => {
  it("preserves native JSON/text response behavior and metadata without eager body consumption", async () => {
    let pulled = 0; const secret = "SECRET_BODY";
    const source = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode(JSON.stringify({ value: secret }))); controller.close(); } }, { highWaterMark: 0 });
    const original = new Response(source, { status: 200, headers: { "Content-Type": "application/json", "X-Fixture": "present" } });
    const log = vi.fn(); const response = observeMcpResponse(original, log, { protocolPhase: "initialize" });
    await Promise.resolve(); expect(pulled).toBe(0); expect(response).toBeInstanceOf(Response); expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("X-Fixture")).toBe("present"); expect(response.url).toBe(original.url); expect(response.status).toBe(original.status);
    const locked = response.body!.getReader(); expect(() => response.clone()).toThrow(); locked.releaseLock();
    expect(await response.json()).toEqual({ value: secret }); expect(response.bodyUsed).toBe(true);
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_complete", expect.objectContaining({ bodyDurationMs: expect.any(Number) }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    await expect(response.text()).rejects.toThrow();
  });
  it("observes pull-based streaming and EOF without retaining or logging chunks", async () => {
    const log = vi.fn(); let reads = 0;
    const original = new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (reads++ === 0) controller.enqueue(new TextEncoder().encode("SECRET_STREAM")); else controller.close(); } }, { highWaterMark: 0 }));
    const response = observeMcpResponse(original, log, {}); expect(reads).toBe(0);
    const reader = response.body!.getReader(); expect(reads).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("SECRET_STREAM");
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_start", expect.any(Object));
    expect(log.mock.calls.some(([, stage]) => stage === "mcp.http.body_complete")).toBe(false);
    expect((await reader.read()).done).toBe(true);
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_complete", expect.any(Object));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET_STREAM");
  });
  it("forwards cancellation without exposing its reason", async () => {
    const cancel = vi.fn(); const log = vi.fn(); const reason = new Error("SECRET_CANCEL_REASON");
    const response = observeMcpResponse(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })), log, {});
    await response.body!.cancel(reason); expect(cancel).toHaveBeenCalledWith(reason);
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_cancelled", expect.any(Object));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET_CANCEL_REASON");
  });
  it("forwards cancellation after streaming has acquired the original reader", async () => {
    const cancel = vi.fn(); const log = vi.fn();
    const source = new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array([1])); }, cancel }, { highWaterMark: 0 }));
    const response = observeMcpResponse(source, log, {}); const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false); await reader.cancel("SECRET_STREAM_CANCEL");
    expect(cancel).toHaveBeenCalledTimes(1); expect(source.body!.locked).toBe(false);
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_cancelled", expect.any(Object));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET_STREAM_CANCEL");
  });
  it.each([false, true])("does not report cancellation complete before the underlying body settles (failure=%s)", async (fail) => {
    const log = vi.fn(); const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const error = new Error("SECRET cancellation failure");
    const response = observeMcpResponse(new Response(new ReadableStream({
      pull() { started.resolve(); },
      async cancel() { await release.promise; if (fail) throw error; },
    }, { highWaterMark: 0 })), log, {});
    const reader = response.body!.getReader(); const read = reader.read(); await started.promise;
    const cancelled = reader.cancel("SECRET cancellation"); const result = cancelled.catch((e) => e);
    await read; await Promise.resolve();
    expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_cancel_start", expect.any(Object));
    expect(log.mock.calls.some(([, stage]) => ["mcp.http.body_complete", "mcp.http.body_cancelled", "mcp.http.body_error"].includes(stage))).toBe(false);
    release.resolve(); expect(await result).toBe(fail ? error : undefined);
    expect(log).toHaveBeenCalledWith(fail ? "error" : "debug", fail ? "mcp.http.body_error" : "mcp.http.body_cancelled", expect.any(Object));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
  it("distinguishes received headers from a response body that finishes later", async () => {
    let clock = 10; const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const log = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = observeMcpResponse(new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, { highWaterMark: 0 })), log, {});
    try {
      const pending = response.json(); await Promise.resolve();
      expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_start", expect.any(Object));
      expect(log.mock.calls.some(([, stage]) => stage === "mcp.http.body_complete")).toBe(false);
      clock = 90; controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close();
      expect(await pending).toEqual({ ok: true });
      expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_complete", expect.objectContaining({ bodyDurationMs: 80 }));
    } finally { now.mockRestore(); }
  });
  it("preserves body errors and tolerates logging faults", async () => {
    const error = new Error("SECRET_BODY_ERROR"); const log = vi.fn();
    const response = observeMcpResponse(new Response(new ReadableStream({ pull(controller) { controller.error(error); } }, { highWaterMark: 0 })), log, {});
    await expect(response.json()).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith("error", "mcp.http.body_error", expect.any(Object)); expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET_BODY_ERROR");
    const faulty = observeMcpResponse(Response.json({ ok: true }), () => { throw error; }, {});
    expect(await faulty.json()).toEqual({ ok: true });
  });
  it("records empty responses immediately and parses only bounded timing/id metadata", () => {
    const log = vi.fn(); const source = new Response(null, { status: 202 });
    expect(observeMcpResponse(source, log, {})).toBe(source); expect(log).toHaveBeenCalledWith("debug", "mcp.http.body_complete", expect.any(Object));
    expect(parseMcpRequestId("SECRET")).toBeUndefined(); expect(readMcpServerDuration("SECRET")).toBeUndefined();
    expect(readMcpServerDuration("proxy;dur=5, mcp_total;dur=123.456, mcp_authentication;dur=2")).toBe(123.456);
    expect(readMcpServerDuration("mcp_total;dur=-1")).toBeUndefined(); expect(readMcpServerDuration("mcp_total;dur=99999999")).toBeUndefined();
  });
});
