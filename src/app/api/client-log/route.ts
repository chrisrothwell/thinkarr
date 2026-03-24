import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Simple in-memory rate limit: max 30 entries per user per minute.
// Resets on a rolling 60-second window. Good enough to prevent accidental
// flooding; no need for a persistent store for a log sink.
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = 30;
const WINDOW_MS = 60_000;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

interface ClientLogBody {
  level?: string;
  message?: string;
  context?: Record<string, unknown>;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
  }

  if (isRateLimited(String(session.user.id))) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: ClientLogBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const level = body.level === "warn" || body.level === "error" ? body.level : "info";
  const message = typeof body.message === "string" ? body.message.slice(0, 500) : "client log";
  const context = body.context && typeof body.context === "object" ? body.context : {};

  logger[level](`[client] ${message}`, { userId: session.user.id, ...context });

  return NextResponse.json({ success: true });
}
