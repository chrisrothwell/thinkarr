import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getLlmClientForEndpoint } from "@/lib/llm/client";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
type TtsVoice = (typeof TTS_VOICES)[number];

// OpenAI TTS input limit
const MAX_TTS_CHARS = 4096;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: { text?: unknown; modelId?: unknown; voice?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  const voiceRaw = typeof body.voice === "string" ? body.voice : "alloy";
  const voice: TtsVoice = (TTS_VOICES as readonly string[]).includes(voiceRaw)
    ? (voiceRaw as TtsVoice)
    : "alloy";

  if (!rawText) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "text is required" },
      { status: 400 },
    );
  }

  // Strip markdown so TTS doesn't read out symbols, then truncate
  const text = stripMarkdown(rawText).slice(0, MAX_TTS_CHARS);

  try {
    const { client } = getLlmClientForEndpoint(modelId);

    const audioResponse = await client.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
    });

    const arrayBuffer = await audioResponse.arrayBuffer();
    logger.info("VOICE_TTS", { userId: session.user.id, chars: text.length, voice });

    return new Response(arrayBuffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "TTS failed";
    logger.error("VOICE_TTS_ERROR", { userId: session.user.id, error: msg });
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}

/**
 * Strip common markdown so TTS reads natural prose instead of symbols.
 */
function stripMarkdown(text: string): string {
  // Remove fenced code blocks via split instead of regex to avoid ReDoS on uncontrolled input.
  // Split on ``` — even-indexed segments are outside code fences, odd-indexed are inside.
  const parts = text.split("```");
  const withoutFences = parts.map((p, i) => (i % 2 === 0 ? p : "code")).join(" ");

  return withoutFences
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Bold / italic (*** ** * ___ __ _)
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // ATX headings (# ## ###)
    .replace(/^#{1,6}\s+/gm, "")
    // Links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Images ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Unordered list bullets
    .replace(/^[\s]*[-*+]\s+/gm, "")
    // Ordered list numbers
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // Blockquotes
    .replace(/^>\s*/gm, "")
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
