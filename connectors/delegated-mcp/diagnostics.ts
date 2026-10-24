import { randomUUID } from "node:crypto";
import { parseMcpRequestId } from "./http-diagnostics.js";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticFields = {
  reason?: string;
  httpStatus?: number;
  rpcCode?: number;
  errorType?: string;
  errorCode?: string;
  validationIssues?: Array<{ field: string; code: string }>;
  bearerAvailable?: boolean;
  keyAvailable?: boolean;
  revisionMatches?: boolean;
  debugEnabled?: boolean;
  mediaEnabled?: boolean;
  outcome?: string;
  acknowledgementConfirmed?: boolean;
  receiptChannelMatches?: boolean;
  receiptMessageIdPresent?: boolean;
  receiptDestinationSupported?: boolean;
  receiptDestinationMatches?: boolean;
  protocolPhase?: "initialize" | "initialized" | "tool_call" | "other";
  receiptDestinationKind?: "pn_jid" | "e164" | "lid" | "group" | "missing" | "other";
  requestId?: string;
  responseRequestId?: string;
  httpDurationMs?: number;
  serverDurationMs?: number;
  outsideHandlerMs?: number;
  bodyDurationMs?: number;
  serverTimingAvailable?: boolean;
};
export type DiagnosticSink = (level: DiagnosticLevel, stage: string, fields?: DiagnosticFields) => void;
export type DiagnosticLogger = { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };

/** Authored reason codes only. Never construct these from upstream text. */
export class ConnectorDiagnosticError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const outcomes = new Set(["linked", "private_link_sent", "private_delivery_unconfirmed", "unavailable", "failed", "ok", "prompt_sent", "submitted", "pending_approval", "expired", "reply_to_prompt", "blocked", "unknown", "unclaimed"]);
const errorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ENOENT", "EACCES", "ELOOP",
]);
const errorNames = new Set(["AbortError", "TimeoutError", "TypeError", "SyntaxError", "ZodError", "McpError", "StreamableHTTPError", "DOMException"]);
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
const validationFields = new Set(["config", "connection", "debug", "accounts", "pilotGroup", "credentialsFile", "endpoint", "publicLinkOrigin", "service", "issuer", "audience", "keyId", "bearer", "privateKeyPem", "status", "content", "_meta", "channel", "account", "recipient", "messageId", "conversation", "accepted", "expiresAt", "url", "version", "linked", "privateDeliveryRequired"]);
const validationCodes = new Set(["invalid_type", "invalid_format", "too_small", "too_big", "unrecognized_keys", "invalid_value", "invalid_union", "custom", "not_multiple_of"]);
function projectValidationIssues(value: unknown): NonNullable<DiagnosticFields["validationIssues"]> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((issue) => {
    if (!issue || typeof issue !== "object" || !validationCodes.has(issue.code)) return [];
    const root = typeof issue.field === "string" ? issue.field : Array.isArray(issue.path) ? issue.path[0] : undefined;
    const field = typeof root === "string" && validationFields.has(root) ? root : "config";
    return [{ field, code: issue.code as string }];
  });
}

/** Exact classifications, not regex-based redaction of arbitrary exception text. */
function classifyError(error: unknown): DiagnosticFields & { errorType: string; errorCode?: string } {
  let current = error;
  let errorCode: string | undefined;
  let rpcCode: number | undefined;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string" && errorCodes.has(code)) errorCode ??= code;
    if (typeof code === "number" && Number.isSafeInteger(code) && code <= -32000 && code >= -32768) rpcCode ??= code;
    current = Reflect.get(current, "cause");
  }
  const name = error && typeof error === "object" ? Reflect.get(error, "name") : undefined;
  const validationIssues = name === "ZodError" ? projectValidationIssues(Reflect.get(error as object, "issues")) : [];
  return {
    reason: error instanceof ConnectorDiagnosticError ? safeCode(error.reason) ?? "operation_failed" : name === "ZodError" ? "validation_failed" : "operation_failed",
    errorType: typeof name === "string" && errorNames.has(name) ? name : "Error",
    ...(errorCode ? { errorCode } : {}), ...(rpcCode !== undefined ? { rpcCode } : {}),
    ...(validationIssues.length ? { validationIssues } : {}),
  };
}

export function diagnosticErrorFields(error: unknown): ReturnType<typeof classifyError> {
  try { return classifyError(error); } catch { return { reason: "operation_failed", errorType: "Error" }; }
}

/** Sink faults must never change delivery/confirmation semantics. */
export function safeDiagnosticSink(sink?: DiagnosticSink): DiagnosticSink {
  return (level, stage, fields) => { try { sink?.(level, stage, fields); } catch { /* logging is best effort */ } };
}

export function createDiagnosticTrace(logger: DiagnosticLogger | undefined, debug: boolean, operation: string) {
  const traceId = randomUUID();
  const started = performance.now();
  // Metadata is projected explicitly. No spreading inputs, errors or config.
  const emit = (level: DiagnosticLevel, stage: string, fields: DiagnosticFields = {}, error?: unknown) => {
    if (!logger || (level === "debug" && !debug)) return;
    try {
      const details = error === undefined ? fields : diagnosticErrorFields(error);
      const reason = safeCode(fields.reason ?? details?.reason);
      const validationIssues = projectValidationIssues(details?.validationIssues);
      const record = {
        component: "thinkarr", traceId, operation: safeCode(operation) ?? "operation", level,
        timestampUtc: new Date().toISOString(),
        stage: /^[a-z][a-z0-9_.]{0,99}$/.test(stage) ? stage : "operation",
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        ...(reason ? { reason } : {}),
        ...(Number.isInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599 ? { httpStatus: fields.httpStatus } : {}),
        ...(details?.errorType && (details.errorType === "Error" || errorNames.has(details.errorType)) ? { errorType: details.errorType } : {}),
        ...(details?.errorCode && errorCodes.has(details.errorCode) ? { errorCode: details.errorCode } : {}),
        ...(Number.isSafeInteger(details?.rpcCode) && details.rpcCode! <= -32000 && details.rpcCode! >= -32768 ? { rpcCode: details.rpcCode } : {}),
        ...(validationIssues.length ? { validationIssues } : {}),
        ...Object.fromEntries((["bearerAvailable", "keyAvailable", "revisionMatches", "debugEnabled", "mediaEnabled", "acknowledgementConfirmed", "receiptChannelMatches", "receiptMessageIdPresent", "receiptDestinationSupported", "receiptDestinationMatches", "serverTimingAvailable"] as const)
          .filter((key) => typeof fields[key] === "boolean").map((key) => [key, fields[key]])),
        ...(typeof fields.outcome === "string" && outcomes.has(fields.outcome) ? { outcome: fields.outcome } : {}),
        ...(fields.protocolPhase && ["initialize", "initialized", "tool_call", "other"].includes(fields.protocolPhase) ? { protocolPhase: fields.protocolPhase } : {}),
        ...(fields.receiptDestinationKind && ["pn_jid", "e164", "lid", "group", "missing", "other"].includes(fields.receiptDestinationKind) ? { receiptDestinationKind: fields.receiptDestinationKind } : {}),
        ...Object.fromEntries((["requestId", "responseRequestId"] as const).flatMap((key) => {
          const value = parseMcpRequestId(fields[key]); return value ? [[key, value]] : [];
        })),
        ...Object.fromEntries((["httpDurationMs", "serverDurationMs", "outsideHandlerMs", "bodyDurationMs"] as const)
          .filter((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]) && fields[key]! >= 0 && fields[key]! <= 86_400_000)
          .map((key) => [key, Math.round(fields[key]! * 1000) / 1000])),
      };
      // Detailed records use info so the plugin switch works without changing
      // the Gateway's global log threshold; the record still says level=debug.
      logger[level === "debug" ? "info" : level](`[thinkarr] ${JSON.stringify(record)}`);
    } catch { /* do not propagate logger faults or serialize their exceptions */ }
  };
  return {
    log: ((level, stage, fields?: DiagnosticFields) => emit(level, stage, fields)) satisfies DiagnosticSink,
    error: (stage: string, error: unknown) => emit("error", stage, {}, error),
  };
}
