import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { orchestrate, generateTitle } from "@/lib/llm/orchestrator";
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

  // 4. Check if this is the first message (for auto-title)
  const isFirstMessage = conversation.title === "New Chat";

  // 5. Stream SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of orchestrate({
          conversationId: body.conversationId,
          userMessage: body.message,
          modelId: body.modelId,
        })) {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Stream error";
        const errorLine = `data: ${JSON.stringify({ type: "error", message: msg })}\n\n`;
        controller.enqueue(encoder.encode(errorLine));
      } finally {
        controller.close();
      }

      // 6. Auto-title (fire-and-forget, after stream completes)
      if (isFirstMessage) {
        generateTitle(body.conversationId, body.message);
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
