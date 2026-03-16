"use client";

import { useState, useRef, useCallback } from "react";

export function useVoiceInput() {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Microphone access denied";
      setError(msg);
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
        } catch {
          setError("Network error during transcription");
          resolve("");
        } finally {
          setTranscribing(false);
        }
      };

      mediaRecorder.stop();
    });
  }, []);

  return { recording, transcribing, startRecording, stopAndTranscribe, error };
}
