import { randomUUID } from "node:crypto";
import { createDiagnosticTrace, type DiagnosticFields, type DiagnosticLogger } from "../delegated-mcp/diagnostics.js";

// Kept in sync with package.json by the lifecycle regression suite. This is
// executing-code metadata, never the saved package or desired upgrade version.
export const COMPANION_VERSION = "0.3.9";
type Trace = ReturnType<typeof createDiagnosticTrace>;
type WorkKind = NonNullable<DiagnosticFields["workKind"]>;
export type Lifecycle = {
  readonly signal?: AbortSignal;
  onDispose?: (cleanup: () => void | Promise<void>) => () => void;
  runInBackgroundContext?: <T>(run: () => T) => T;
};

/** Observations of companion-owned executions, NOT the host's lease inventory.
 * Inventory holds fixed metadata and cancellation signals, never identities,
 * arguments, results or transport objects. Abort reasons are never inspected.
 * Observation never cancels, releases or retries admitted work.
 */
export function createLifecycleDiagnostics(lifecycle: Lifecycle, logger: DiagnosticLogger | undefined, debug: boolean, registrationMode: "full" | "tool-discovery") {
  const context = { instanceId: randomUUID(), companionVersion: COMPANION_VERSION, registrationMode };
  const trace = (operation: string) => createDiagnosticTrace(logger, debug, operation, context);
  const log = trace("lifecycle");
  const work = new Map<string, { kind: WorkKind; started: number; stage: string; signal?: AbortSignal }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const age = (started: number) => Math.min(86_400_000, Math.max(0, performance.now() - started));
  const facts = () => ({ trackedWorkCount: work.size, oldestWorkMs: Math.max(0, ...Array.from(work.values(), (item) => age(item.started))), lifecycleAborted: lifecycle.signal?.aborted === true });
  const snapshot = (stage: string, level: "info" | "debug") => {
    log.log(level, stage, facts());
    // Bound output, while keeping the total inventory count exact.
    for (const [workId, item] of Array.from(work).slice(0, 20)) log.log(level, "lifecycle.work_pending", {
      workId, workKind: item.kind, workStage: item.stage, workAgeMs: age(item.started), invocationAborted: item.signal?.aborted === true,
    });
  };
  const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  const abort = () => { stopTimer(); snapshot("lifecycle.signal_aborted", "info"); };
  // The pinned host aborts this signal during disposal, which may be AFTER a
  // pre-replacement drain. Heartbeats therefore also report an idle instance.
  lifecycle.signal?.addEventListener("abort", abort, { once: true });
  try {
    lifecycle.onDispose?.(() => {
      stopTimer();
      lifecycle.signal?.removeEventListener("abort", abort);
      snapshot("lifecycle.dispose", "info");
    });
  } catch (error) { log.error("lifecycle.observer_unavailable", error); }
  log.log("info", "lifecycle.ready", { ...facts(), backgroundDiagnosticsAvailable: typeof lifecycle.runInBackgroundContext === "function" });
  if (lifecycle.signal?.aborted) abort();
  else if (debug && registrationMode === "full" && lifecycle.runInBackgroundContext) {
    // Detach registration's caller/request scope using the public host API.
    // Never create a referenced polling timer or a new retained-work token.
    try {
      lifecycle.runInBackgroundContext(() => {
        timer = setInterval(() => snapshot("lifecycle.snapshot", "debug"), 10_000);
        timer.unref();
      });
    } catch (error) { stopTimer(); log.error("lifecycle.observer_unavailable", error); }
  }
  return {
    trace,
    async run<T>(kind: WorkKind, operation: string, signal: AbortSignal | undefined, execute: (trace: Trace) => Promise<T>): Promise<T> {
      const original = trace(operation);
      const item = { kind, started: performance.now(), stage: "work.started", signal };
      work.set(original.traceId, item);
      const fields = () => ({ ...facts(), workId: original.traceId, workKind: kind, workStage: item.stage, workAgeMs: age(item.started), invocationAborted: signal?.aborted === true });
      const cancelled = () => log.log("info", "lifecycle.work_cancelled", fields());
      signal?.addEventListener("abort", cancelled, { once: true });
      log.log("info", "lifecycle.work_started", fields());
      if (signal?.aborted) cancelled();
      const tracked: Trace = { traceId: original.traceId,
        log: (level, stage, details) => { item.stage = stage; original.log(level, stage, details); },
        error: (stage, error) => { item.stage = stage; original.error(stage, error); },
      };
      try { return await execute(tracked); }
      finally {
        signal?.removeEventListener("abort", cancelled);
        work.delete(original.traceId);
        log.log("info", "lifecycle.work_settled", fields());
      }
    },
  };
}
