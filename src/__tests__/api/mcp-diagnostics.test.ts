import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConnectorDiagnosticError, createDiagnosticTrace, diagnosticErrorFields, safeDiagnosticSink } from "../../../connectors/delegated-mcp/diagnostics";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const records = (log: ReturnType<typeof logger>) => [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
  .map(([line]) => JSON.parse(line.slice("[thinkarr] ".length)));

describe("value-free companion diagnostics", () => {
  it("keeps errors and summaries on by default, gates debug stages, and gives each operation an independent correlation ID", () => {
    const log = logger();
    const first = createDiagnosticTrace(log, false, "link_start");
    first.log("debug", "secrets.prepared_read");
    first.log("info", "operation.started");
    first.error("credentials.load", new ConnectorDiagnosticError("prepared_bearer_unavailable"));
    expect(records(log).map((r) => r.stage)).toEqual(["operation.started", "credentials.load"]);
    expect(new Set(records(log).map((r) => r.traceId)).size).toBe(1);
    expect(records(log).find((r) => r.level === "error")).toMatchObject({ reason: "prepared_bearer_unavailable", operation: "link_start" });
    const second = createDiagnosticTrace(log, true, "link_complete");
    second.log("debug", "mcp.http.response", { httpStatus: 200, protocolPhase: "initialize" });
    expect(records(log).find((r) => r.stage === "mcp.http.response")).toMatchObject({ level: "debug", httpStatus: 200, protocolPhase: "initialize" });
    expect(new Set(records(log).map((r) => r.traceId)).size).toBe(2);
  });

  it("projects only bounded metadata and exact error classifications, never raw messages, stacks, causes or extra fields", () => {
    const log = logger(); const trace = createDiagnosticTrace(log, true, "link_start");
    const secret = "SENSITIVE_BEARER_PRIVATE_LINK_ACTOR_CONTENT";
    const error = new TypeError(secret, { cause: Object.assign(new Error(secret), { code: "ECONNREFUSED", url: secret }) });
    trace.error("mcp.http.fetch", error);
    trace.log("debug", "secrets.prepared_status", { bearerAvailable: false, keyAvailable: true, revisionMatches: true,
      reason: secret, outcome: secret, httpStatus: 999, protocolPhase: secret, receiptDestinationKind: secret, bearer: secret, message: secret } as never);
    expect(records(log).find((r) => r.stage === "mcp.http.fetch")).toMatchObject({ errorType: "TypeError", errorCode: "ECONNREFUSED" });
    expect(records(log).find((r) => r.stage === "secrets.prepared_status")).toMatchObject({ bearerAvailable: false, keyAvailable: true, revisionMatches: true });
    expect(records(log).find((r) => r.stage === "secrets.prepared_status")).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(records(log))).not.toContain(secret);
    expect(diagnosticErrorFields(Object.assign(new Error(secret), { code: secret, name: secret }))).toEqual({ reason: "operation_failed", errorType: "Error" });
    expect(diagnosticErrorFields(new Proxy({}, { get() { throw error; } }))).toEqual({ reason: "operation_failed", errorType: "Error" });
    const validation = z.object({ bearer: z.string().regex(/^valid$/) }).strict().safeParse({ bearer: secret, [secret]: secret });
    if (validation.success) throw new Error("Expected validation failure");
    trace.error("credentials.load", validation.error);
    expect(records(log).find((r) => r.stage === "credentials.load")).toMatchObject({ reason: "validation_failed", validationIssues: expect.arrayContaining([{ field: "bearer", code: "invalid_format" }]) });
    expect(JSON.stringify(records(log))).not.toContain(secret);
  });

  it("does not let logger/sink failures escape into application or delivery paths", () => {
    const fail = () => { throw new Error("LOGGER SECRET"); };
    const trace = createDiagnosticTrace({ info: fail, warn: fail, error: fail }, true, "link_start");
    expect(() => trace.log("debug", "mcp.connect")).not.toThrow();
    expect(() => trace.error("credentials.load", new Error("SECRET"))).not.toThrow();
    expect(() => safeDiagnosticSink(fail)("error", "mcp.connect")).not.toThrow();
  });
  it("projects lifecycle metadata without accepting arbitrary versions, identities or resource objects", () => {
    const log = logger(); const id = "12345678-1234-1234-1234-123456789abc";
    const trace = createDiagnosticTrace(log, true, "lifecycle", { instanceId: id, companionVersion: "0.3.8", registrationMode: "full" });
    trace.log("info", "lifecycle.work_pending", { workId: id, exchangeId: id, workKind: "private_hook", workStage: "outbound.ack_send", workAgeMs: 20, trackedWorkCount: 1, pendingHttpCount: 0, pendingBodyCount: 1, invocationAborted: true });
    expect(records(log)[0]).toMatchObject({ instanceId: id, companionVersion: "0.3.8", workId: id, exchangeId: id, workKind: "private_hook", workStage: "outbound.ack_send", trackedWorkCount: 1, pendingHttpCount: 0, pendingBodyCount: 1, invocationAborted: true });
    trace.log("info", "lifecycle.snapshot", { workId: "SECRET", workKind: "SECRET", workStage: "SECRET", trackedWorkCount: -1, pendingHttpCount: NaN, pendingBodyCount: 1.5, workAgeMs: Infinity, invocationAborted: "SECRET", resources: { key: "SECRET" } } as never);
    expect(JSON.stringify(records(log))).not.toContain("SECRET");
    for (const field of ["workId", "workKind", "workStage", "trackedWorkCount", "pendingHttpCount", "pendingBodyCount", "workAgeMs", "invocationAborted", "resources"]) expect(records(log)[1]).not.toHaveProperty(field);
  });
});
