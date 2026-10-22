import { NextResponse } from "next/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, InitializeRequestSchema, JSONRPCNotificationSchema, JSONRPCRequestSchema,
  ListToolsRequestSchema, McpError, ErrorCode, type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "@/lib/logger";
import type { ServiceMcpContext } from "./auth-context";
import { DelegationError, requireCurrentDelegation, verifyDelegatedRequest, type VerifiedServiceMcpContext } from "./delegation";
import { AccountLinkError, completeAccountLink, initiateAccountLink } from "./account-linking";
import { recordServiceMcpDenial } from "./service-principals";
import { authorizeMediaCall, callMediaTool, serviceMediaTools } from "./media-dispatch";

const privacyHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const startArguments = z.object({}).strict();
const completeArguments = z.object({ code: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const linkTools: Tool[] = [
  {
    name: "account_link_start",
    description: "Prepare a private Plex account-linking handoff for the authenticated participant. A trusted connector must deliver the private metadata separately; never publish it in chat or model context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "account_link_confirm",
    description: "Complete a pending account link using a verified private sender message. Available only to trusted channel infrastructure, not model-originated calls.",
    inputSchema: { type: "object", properties: { code: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["code"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

class LinkDispatchDenied extends Error {}

/** Same exact-name policy for discovery and direct execution. No raw registry,
 * personal role, caller user ID or name normalization participates here.
 */
export function serviceLinkTools(context: VerifiedServiceMcpContext): Tool[] {
  const current = requireCurrentDelegation(context);
  const c = context.delegation;
  if (c.channel !== "whatsapp") throw new LinkDispatchDenied();
  return [...linkTools.filter((tool) => current.allowedOperations.includes(tool.name) && (
    (tool.name === "account_link_start" && (c.source === "tool" || (c.source === "command" && c.intent === "link-start")))
    || (tool.name === "account_link_confirm" && c.source === "message" && c.kind === "direct" && /^link-confirm:[a-f0-9]{64}$/.test(c.intent ?? ""))
  )), ...serviceMediaTools(context)];
}

function authorizeCall(context: VerifiedServiceMcpContext, name: string, args: unknown) {
  if (!serviceLinkTools(context).some((tool) => tool.name === name)) throw new LinkDispatchDenied();
  if (name.startsWith("media_")) {
    try { authorizeMediaCall(context, name, args ?? {}); return; }
    catch { throw new LinkDispatchDenied(); }
  }
  if (name === "account_link_start") {
    if (!startArguments.safeParse(args ?? {}).success) throw new LinkDispatchDenied();
  } else {
    const parsed = completeArguments.safeParse(args);
    if (!parsed.success || context.delegation.intent !== `link-confirm:${parsed.data.code}`) throw new LinkDispatchDenied();
  }
}

async function callLinkTool(context: VerifiedServiceMcpContext, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  authorizeCall(context, name, args);
  if (name.startsWith("media_")) return callMediaTool(context, name, args ?? {}, signal);
  if (name === "account_link_confirm") {
    const result = completeAccountLink(context, completeArguments.parse(args).code);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  const result = initiateAccountLink(context);
  if (result.linked) return { content: [{ type: "text", text: JSON.stringify({ linked: true }) }] };
  // _meta is transport data for the trusted connector, NOT a privacy guarantee
  // from arbitrary MCP clients. Activation stays disabled until an adapter
  // consumes it privately and returns only the receipt-based safe outcome.
  return {
    content: [{ type: "text", text: JSON.stringify({ linked: false, privateDeliveryRequired: true }) }],
    _meta: {
      "thinkarr/private-delivery": {
        version: 1, channel: context.delegation.channel, account: context.delegation.account,
        recipient: context.delegation.sender, url: result.privateLinkUrl, expiresAt: result.expiresAt.toISOString(),
      },
    },
  };
}

function forbidden(caller: ServiceMcpContext) {
  recordServiceMcpDenial(caller);
  return NextResponse.json({ error: "Delegated MCP operation is not permitted." }, { status: 403, headers: privacyHeaders });
}

/** Signed standard MCP, linking plus explicitly configured beta media pilot.
 * Personal/legacy registry handlers never receive a service context.
 */
export async function handleServiceLinkPost(request: Request, caller: ServiceMcpContext): Promise<Response> {
  let raw: Uint8Array;
  let context: VerifiedServiceMcpContext;
  let envelope: { method: string };
  try {
    raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > 65536) return NextResponse.json({ error: "MCP request is too large" }, { status: 413, headers: privacyHeaders });
    context = await verifyDelegatedRequest(request, raw, caller);
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new LinkDispatchDenied();
    const parsed = (Object.hasOwn(body, "id") ? JSONRPCRequestSchema : JSONRPCNotificationSchema).safeParse(body);
    if (!parsed.success) throw new LinkDispatchDenied();
    envelope = parsed.data;
    if (envelope.method === "notifications/initialized") {
      if (Object.hasOwn(body, "id")) throw new LinkDispatchDenied();
    } else {
      if (!Object.hasOwn(body, "id")) throw new LinkDispatchDenied();
      if (envelope.method === "initialize") {
        if (!InitializeRequestSchema.safeParse(body).success) throw new LinkDispatchDenied();
      } else if (envelope.method === "tools/list") {
        if (!ListToolsRequestSchema.safeParse(body).success) throw new LinkDispatchDenied();
      } else if (envelope.method === "tools/call") {
        const call = CallToolRequestSchema.safeParse(body);
        if (!call.success) throw new LinkDispatchDenied();
        authorizeCall(context, call.data.params.name, call.data.params.arguments);
      } else if (envelope.method !== "ping") throw new LinkDispatchDenied();
    }
    // Recheck principal/key/time/channel for every protocol operation as well.
    serviceLinkTools(context);
  } catch (error) {
    if (error instanceof DelegationError || error instanceof LinkDispatchDenied || error instanceof SyntaxError) return forbidden(caller);
    logger.error("MCP_LINK_DISPATCH_FAILURE", { principalId: caller.principalId, credentialId: caller.credentialId });
    return NextResponse.json({ error: "Delegated MCP request failed" }, { status: 500, headers: privacyHeaders });
  }

  let deniedDuringDispatch = false;
  const server = new Server({ name: "thinkarr", version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return { tools: serviceLinkTools(context) }; }
    catch { deniedDuringDispatch = true; throw new McpError(ErrorCode.InvalidParams, "Delegated MCP operation is not permitted."); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try { return await callLinkTool(context, call.params.name, call.params.arguments, request.signal); }
    catch (error) {
      if (error instanceof DelegationError || error instanceof LinkDispatchDenied || (error instanceof AccountLinkError && error.status === 403)) {
        deniedDuringDispatch = true;
        throw new McpError(ErrorCode.InvalidParams, "Delegated MCP operation is not permitted.");
      }
      if (error instanceof AccountLinkError) return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      if (call.params.name.startsWith("media_")) return { content: [{ type: "text", text: JSON.stringify({ status: "failed" }) }], isError: true };
      logger.error("MCP_LINK_TOOL_FAILURE", { principalId: caller.principalId, credentialId: caller.credentialId });
      return { content: [{ type: "text", text: "Account linking could not be completed." }], isError: true };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.from(raw) }), {
      authInfo: { token: request.headers.get("authorization")!.slice(7), clientId: caller.principalId, scopes: serviceLinkTools(context).map((tool) => tool.name) },
    });
    // The stateless transport uses JSON responses; await its body so a revoked
    // policy discovered inside the SDK handler still becomes HTTP 403.
    const body = await response.arrayBuffer();
    if (deniedDuringDispatch) return forbidden(caller);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(privacyHeaders)) headers.set(key, value);
    return new Response(body.byteLength ? body : null, { status: response.status, headers });
  } catch (error) {
    if (error instanceof DelegationError || error instanceof LinkDispatchDenied) return forbidden(caller);
    logger.error("MCP_LINK_TRANSPORT_FAILURE", { principalId: caller.principalId, credentialId: caller.credentialId });
    return NextResponse.json({ error: "Delegated MCP request failed" }, { status: 500, headers: privacyHeaders });
  } finally {
    await server.close().catch(() => {});
  }
}
