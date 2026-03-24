import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { orchestrate, generateTitle } from "@/lib/llm/orchestrator";
import { getRateLimit, getPeriodStart, getNextPeriodStart, countUserMessagesSince } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { ChatRequest } from "@/types/chat";

export async function POST(request: Request) {
  // 1. Auth check
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ success: false, error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Parse body
  let body: ChatRequest;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.conversationId || !body.message?.trim()) {
    return new Response(
      JSON.stringify({ success: false, error: "conversationId and message are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (body.message.length > 4000) {
    return new Response(
      JSON.stringify({ success: false, error: "Message too long (max 4000 characters)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  logger.info("Chat request received", { userId: session.user.id, conversationId: body.conversationId });

  // 3. Verify conversation ownership
  const db = getDb();
  const conversation = db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, body.conversationId),
        eq(schema.conversations.userId, session.user.id),
      ),
    )
    .get();

  if (!conversation) {
    return new Response(
      JSON.stringify({ success: false, error: "Conversation not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // 4. Rate limit check
  const rateLimit = getRateLimit(session.user.id);
  const periodStart = getPeriodStart(rateLimit.period);
  const messageCount = countUserMessagesSince(session.user.id, periodStart);
  if (messageCount >= rateLimit.messages) {
    logger.warn("Rate limit hit", { userId: session.user.id, messageCount, limit: rateLimit.messages });
    const resetAt = getNextPeriodStart(rateLimit.period);
    const pad = (n: number) => String(n).padStart(2, "0");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const resetStr = `${pad(resetAt.getDate())}/${months[resetAt.getMonth()]}/${String(resetAt.getFullYear()).slice(2)} ${pad(resetAt.getHours())}:${pad(resetAt.getMinutes())}`;
    const encoder = new TextEncoder();
    const limitStream = new ReadableStream({
      start(controller) {
        const event = { type: "error", message: `Your Session Limit has expired and will refresh on ${resetStr}.` };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(limitStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // 5. Check if this is the first message (for auto-title)
  const isFirstMessage = conversation.title === "New Chat";

  // 5. Stream SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Track whether the SSE client is still connected. When the client
      // disconnects (e.g. mobile app backgrounded), controller.enqueue()
      // throws because the WHATWG stream is cancelled. We catch that error
      // so the orchestrator keeps running and saves all tool results to the
      // DB — the client can reload the conversation when it reconnects.
      let clientConnected = true;

      const enqueue = (line: Uint8Array) => {
        if (!clientConnected) return;
        try {
          controller.enqueue(line);
        } catch {
          clientConnected = false;
          logger.info("SSE client disconnected — continuing orchestration in background", {
            conversationId: body.conversationId,
          });
        }
      };

      try {
        for await (const event of orchestrate({
          conversationId: body.conversationId,
          userMessage: body.message,
          modelId: body.modelId,
        })) {
          enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }

        // 6. Generate title for new chats and emit it before closing so the
        //    sidebar updates in real-time without a page refresh.
        if (isFirstMessage) {
          const newTitle = await generateTitle(body.conversationId, body.message);
          if (newTitle) {
            const titleEvent = { type: "title_update", conversationId: body.conversationId, title: newTitle };
            enqueue(encoder.encode(`data: ${JSON.stringify(titleEvent)}\n\n`));
          }
        }

        enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Stream error";
        enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        try { controller.close(); } catch { /* already closed by client disconnect */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
