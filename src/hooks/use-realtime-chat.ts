"use client";

import { useState, useRef, useCallback } from "react";

export interface RealtimeTurn {
  role: "user" | "assistant";
  text: string;
}

interface SessionData {
  clientSecret: string;
  realtimeModel: string;
  rtcBaseUrl: string;
}

export function useRealtimeChat(modelId: string) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [transcript, setTranscript] = useState<RealtimeTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef<SessionData | null>(null);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify(event));
    }
  }, []);

  const handleDataChannelMessage = useCallback(
    async (raw: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      const type = event.type as string;

      // Accumulate assistant audio transcript
      if (type === "response.audio_transcript.delta") {
        const delta = event.delta as string;
        setTranscript((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [...prev, { role: "assistant", text: delta }];
        });
      }

      // User transcript (speech-to-text from input audio)
      if (type === "conversation.item.input_audio_transcription.completed") {
        const text = event.transcript as string;
        if (text) {
          setTranscript((prev) => [...prev, { role: "user", text }]);
        }
      }

      // Tool call — execute server-side and return result
      if (type === "response.function_call_arguments.done") {
        const callId = event.call_id as string;
        const name = event.name as string;
        const argsStr = event.arguments as string;

        try {
          const res = await fetch("/api/realtime/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toolName: name, toolArgs: JSON.parse(argsStr || "{}") }),
          });
          const data = await res.json();
          const output = data.success ? data.data.result : JSON.stringify({ error: data.error });

          // Send tool result back to the realtime session
          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output,
            },
          });
          // Ask the model to respond
          sendEvent({ type: "response.create" });
        } catch {
          // Send error as tool result
          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ error: "Tool execution failed" }),
            },
          });
          sendEvent({ type: "response.create" });
        }
      }
    },
    [sendEvent],
  );

  const connect = useCallback(async () => {
    if (connected || connecting) return;
    setConnecting(true);
    setError(null);
    setTranscript([]);

    // Microphone access requires a secure context (HTTPS or localhost)
    if (!window.isSecureContext) {
      setError("Microphone access requires a secure connection (HTTPS). Please reload over HTTPS.");
      setConnecting(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Your browser does not support microphone access. Please use a modern browser.");
      setConnecting(false);
      return;
    }

    try {
      // 1. Get ephemeral session token from our server
      const sessionRes = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const sessionData = await sessionRes.json();
      if (!sessionData.success) {
        throw new Error(sessionData.error || "Failed to create realtime session");
      }
      const session = sessionData.data as SessionData;
      sessionRef.current = session;

      // 2. Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3. Set up remote audio playback
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      // 4. Add local microphone track
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // 5. Create data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        // Enable input audio transcription so user speech is surfaced as text
        sendEvent({
          type: "session.update",
          session: {
            input_audio_transcription: { model: "whisper-1" },
          },
        });
      };

      dc.onmessage = (e) => handleDataChannelMessage(e.data as string);

      // 6. Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Exchange SDP with OpenAI Realtime API
      const sdpRes = await fetch(
        `${session.rtcBaseUrl}/realtime?model=${encodeURIComponent(session.realtimeModel)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
            Authorization: `Bearer ${session.clientSecret}`,
          },
          body: offer.sdp,
        },
      );

      if (!sdpRes.ok) {
        throw new Error(`SDP exchange failed: ${sdpRes.status}`);
      }

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setConnected(true);
    } catch (e) {
      let msg: string;
      if (e instanceof DOMException) {
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
          msg =
            "Microphone access was denied. To fix this: click the lock or camera icon in your browser\u2019s address bar, allow microphone access, then reload the page.";
        } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
          msg = "No microphone found. Please connect a microphone and try again.";
        } else {
          msg = `Microphone error: ${e.message}`;
        }
      } else {
        msg = e instanceof Error ? e.message : "Connection failed";
      }
      setError(msg);
      pcRef.current?.close();
      pcRef.current = null;
    } finally {
      setConnecting(false);
    }
  }, [modelId, connected, connecting, handleDataChannelMessage, sendEvent]);

  const disconnect = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
    }
    pcRef.current = null;
    dcRef.current = null;
    sessionRef.current = null;
    setConnected(false);
    setConnecting(false);
  }, []);

  return { connected, connecting, transcript, connect, disconnect, error };
}
