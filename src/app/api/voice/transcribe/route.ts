import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getLlmClientForEndpoint } from "@/lib/llm/client";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid form data" },
      { status: 400 },
    );
  }

  const audioFile = formData.get("audio");
  const modelId = (formData.get("modelId") as string) || "";

  if (!audioFile || !(audioFile instanceof Blob)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "audio field is required" },
      { status: 400 },
    );
  }

  try {
    const { client } = getLlmClientForEndpoint(modelId);
    const file = new File([audioFile], "recording.webm", { type: audioFile.type || "audio/webm" });

    const transcription = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    logger.info("VOICE_TRANSCRIBE", { userId: session.user.id, chars: transcription.text.length });

    return NextResponse.json<ApiResponse>({
      success: true,
      data: { transcript: transcription.text },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Transcription failed";
    logger.error("VOICE_TRANSCRIBE_ERROR", { userId: session.user.id, error: msg });
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
