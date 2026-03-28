"use client";

import { useState, useRef, useCallback } from "react";
import { clientLog } from "@/lib/client-logger";

export function useTts(modelId: string) {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speakText = useCallback(
    async (text: string, voice = "alloy"): Promise<void> => {
      if (!text.trim()) return;
      stop();

      setSpeaking(true);
      try {
        const res = await fetch("/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, modelId, voice }),
        });

        if (!res.ok) {
          setSpeaking(false);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;

        await new Promise<void>((resolve) => {
          audio.onended = () => {
            if (objectUrlRef.current === url) {
              URL.revokeObjectURL(url);
              objectUrlRef.current = null;
            }
            audioRef.current = null;
            setSpeaking(false);
            resolve();
          };
          audio.onerror = () => {
            if (objectUrlRef.current === url) {
              URL.revokeObjectURL(url);
              objectUrlRef.current = null;
            }
            audioRef.current = null;
            setSpeaking(false);
            resolve();
          };
          audio.play().catch(() => {
            setSpeaking(false);
            resolve();
          });
        });
      } catch (e: unknown) {
        clientLog.error("TTS playback failure", {
          errorName: e instanceof Error ? e.name : "UnknownError",
          errorMessage: e instanceof Error ? e.message : "Unknown error",
        });
        setSpeaking(false);
      }
    },
    [modelId, stop],
  );

  return { speaking, speakText, stop };
}
