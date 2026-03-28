"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { clientLog } from "@/lib/client-logger";

export function useVoiceInput() {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);

    // Microphone access requires a secure context (HTTPS or localhost)
    if (!window.isSecureContext) {
      setError("Microphone access requires a secure connection (HTTPS). Please reload over HTTPS.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Your browser does not support microphone access. Please use a modern browser.");
      return;
    }

    try {
      const liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = liveStream;
      setStream(liveStream);
      const mediaRecorder = new MediaRecorder(liveStream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (e) {
      if (e instanceof DOMException) {
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
          setError(
            "Microphone access was denied. To fix this: click the lock or camera icon in your browser\u2019s address bar, allow microphone access, then reload the page.",
          );
        } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
          setError("No microphone found. Please connect a microphone and try again.");
        } else {
          setError(`Microphone error: ${e.message}`);
        }
      } else {
        setError(e instanceof Error ? e.message : "Microphone access denied");
      }
    }
  }, []);

  const stopAndTranscribe = useCallback(async (modelId: string): Promise<string> => {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      return "";
    }

    return new Promise((resolve) => {
      mediaRecorder.onstop = async () => {
        setRecording(false);
        // Stop all mic tracks
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setStream(null);

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];

        setTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", blob, "recording.webm");
          form.append("modelId", modelId);
          const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
          const data = await res.json();
          if (data.success) {
            resolve(data.data.transcript as string);
          } else {
            setError(data.error || "Transcription failed");
            resolve("");
          }
        } catch (e: unknown) {
          clientLog.error("Transcription network failure", {
            errorName: e instanceof Error ? e.name : "UnknownError",
            errorMessage: e instanceof Error ? e.message : "Unknown error",
            online: typeof navigator !== "undefined" ? navigator.onLine : null,
          });
          setError("Network error during transcription");
          resolve("");
        } finally {
          setTranscribing(false);
        }
      };

      mediaRecorder.stop();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    const mediaRecorder = mediaRecorderRef.current;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = null; // discard any pending transcription
      mediaRecorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    chunksRef.current = [];
    setRecording(false);
  }, []);

  // Stop the mic if the component using this hook is unmounted while recording
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { recording, transcribing, startRecording, stopAndTranscribe, cancelRecording, error, stream };
}
