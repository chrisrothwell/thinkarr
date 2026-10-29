import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_VERSION, createLifecycleDiagnostics } from "../../../connectors/openclaw/lifecycle";
import pkg from "../../../connectors/openclaw/package.json";

function fixture(debug = true, mode: "full" | "tool-discovery" = "full") {
  const controller = new AbortController();
  let dispose: (() => void | Promise<void>) | undefined;
  const lines: string[] = [];
  const logger = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const background = vi.fn();
  const diagnostics = createLifecycleDiagnostics({ signal: controller.signal, runInBackgroundContext: <T>(run: () => T) => { background(); return run(); },
    onDispose: (fn) => { dispose = fn; return () => { dispose = undefined; }; },
  }, logger, debug, mode);
  return { controller, diagnostics, background, dispose: () => dispose?.(),
    records: () => lines.map((line) => JSON.parse(line.slice("[thinkarr] ".length))) };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

describe("companion lifecycle observations", () => {
  it("identifies executing code and independent instances, with detached idle snapshots and disposable timers", async () => {
    vi.useFakeTimers();
    expect(COMPANION_VERSION).toBe(pkg.version);
    const h = fixture(); const other = fixture();
    expect(h.background).toHaveBeenCalledOnce();
    expect(h.records()[0]).toMatchObject({ stage: "lifecycle.ready", companionVersion: pkg.version, registrationMode: "full", trackedWorkCount: 0 });
    expect(h.records()[0].instanceId).not.toBe(other.records()[0].instanceId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.records().at(-1)).toMatchObject({ stage: "lifecycle.snapshot", trackedWorkCount: 0 });
    h.controller.abort(new Error("SECRET disposal reason")); await h.dispose(); await other.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.records().map((row) => row.stage)).toContain("lifecycle.signal_aborted");
    expect(h.records().at(-1)).toMatchObject({ stage: "lifecycle.dispose", lifecycleAborted: true });
    expect(JSON.stringify(h.records())).not.toContain("SECRET");
  });
  it.each(["completed", "failed", "cancelled"] as const)("clears work after %s without releasing it before physical settlement", async (outcome) => {
    vi.useFakeTimers(); const h = fixture(); const pending = deferred(); const invocation = new AbortController();
    const execution = h.diagnostics.run("private_hook", "link_complete", invocation.signal, async (trace) => {
      trace.log("debug", "outbound.ack_send"); await pending.promise;
    });
    const result = execution.catch((error) => error);
    if (outcome === "cancelled") invocation.abort(new Error("SECRET cancellation"));
    await vi.advanceTimersByTimeAsync(10_000);
    const snapshot = h.records().filter((row) => row.stage === "lifecycle.work_pending").at(-1);
    expect(snapshot).toMatchObject({ workKind: "private_hook", workStage: "outbound.ack_send", workAgeMs: 10_000, invocationAborted: outcome === "cancelled" });
    expect(h.records().find((row) => row.stage === "lifecycle.snapshot")).toMatchObject({ trackedWorkCount: 1 });
    // Even disposal observations must not detach, cancel or falsely finish a send.
    await h.dispose();
    expect(h.records().filter((row) => row.stage === "lifecycle.dispose").at(-1)).toMatchObject({ trackedWorkCount: 1 });
    if (outcome === "failed") pending.reject(new Error("SECRET failure")); else pending.resolve();
    await result;
    expect(h.records().at(-1)).toMatchObject({ stage: "lifecycle.work_settled", trackedWorkCount: 0, workId: snapshot.workId });
    expect(JSON.stringify(h.records())).not.toContain("SECRET");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains concurrent work separately and includes cleanup stages through late settlement", async () => {
    vi.useFakeTimers(); const h = fixture(); const first = deferred(); const second = deferred();
    const a = h.diagnostics.run("link_tool", "link_start", undefined, async (trace) => { trace.log("info", "mcp.close"); await first.promise; });
    const b = h.diagnostics.run("group_hook", "media_confirm_request", undefined, async (trace) => { trace.log("debug", "outbound.result_send"); await second.promise; });
    first.resolve(); await a; await vi.advanceTimersByTimeAsync(10_000);
    expect(h.records().filter((row) => row.stage === "lifecycle.snapshot").at(-1)).toMatchObject({ trackedWorkCount: 1 });
    expect(h.records().filter((row) => row.stage === "lifecycle.work_pending").at(-1)).toMatchObject({ workKind: "group_hook", workStage: "outbound.result_send" });
    h.controller.abort(); second.resolve(); await b; await h.dispose();
    expect(h.records().at(-1)).toMatchObject({ stage: "lifecycle.dispose", trackedWorkCount: 0 });
  });
  it.each([[false, "full"], [true, "tool-discovery"]] as const)("does not poll with debug=%s mode=%s", (debug, mode) => {
    vi.useFakeTimers(); const h = fixture(debug, mode);
    expect(h.background).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    h.dispose();
  });
});
