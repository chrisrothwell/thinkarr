"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { clientLog } from "@/lib/client-logger";

interface SessionData {
  clientSecret: string;
  realtimeModel: string;
  rtcBaseUrl: string;
}

interface UseRealtimeChatOptions {
  /** Called when a user or assistant turn completes (transcript text). */
  onTurnComplete?: (role: "user" | "assistant", text: string) => void;
  /**
   * Active conversation ID. When provided, tool calls and their results are
   * persisted to the conversation so they appear in the main chat window.
   */
  conversationId?: string | null;
  /**
   * Called after each tool result is saved to the DB so the caller can
   * reload the message list and render the updated tool cards.
   */
  onMessagesUpdated?: () => void;
}

export function useRealtimeChat(modelId: string, options: UseRealtimeChatOptions = {}) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef<SessionData | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Stable refs so event-handler closures always read the latest values
  // without needing them as effect / callback dependencies.
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const onTurnCompleteRef = useRef(options.onTurnComplete);
  onTurnCompleteRef.current = options.onTurnComplete;
  const conversationIdRef = useRef(options.conversationId);
  conversationIdRef.current = options.conversationId;
  const onMessagesUpdatedRef = useRef(options.onMessagesUpdated);
  onMessagesUpdatedRef.current = options.onMessagesUpdated;

  // Set when the user explicitly calls disconnect() so that dc.onclose /
  // pc.onconnectionstatechange know not to show an error message.
  const intentionalDisconnectRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Wake Lock helpers
  // ---------------------------------------------------------------------------

  const acquireWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Wake lock denied or not available — not critical, session continues
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  // Re-acquire the wake lock when the page becomes visible again — the browser
  // auto-releases it when the page is hidden (screen off, app backgrounded).
  // If the session survived the background period, keep the screen on.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "visible" && connectedRef.current) {
        await acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [acquireWakeLock]);

  // ---------------------------------------------------------------------------
  // Unexpected-disconnect handler (shared between pc and dc events)
  // ---------------------------------------------------------------------------

  const handleUnexpectedDisconnect = useCallback(() => {
    if (intentionalDisconnectRef.current) return;
    releaseWakeLock();
    pcRef.current?.close();
    pcRef.current = null;
    dcRef.current = null;
    sessionRef.current = null;
    setConnected(false);
    setConnecting(false);
    setError("Connection lost. Tap Connect to start a new session.");
  }, [releaseWakeLock]);

  // ---------------------------------------------------------------------------
  // Data channel message handler
  // ---------------------------------------------------------------------------

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

      // Assistant turn complete — save to conversation and refresh message list
      if (type === "response.audio_transcript.done") {
        const text = (event.transcript as string) ?? "";
        if (text) {
          onTurnCompleteRef.current?.("assistant", text);
        }
      }

      // User transcript (speech-to-text from input audio)
      if (type === "conversation.item.input_audio_transcription.completed") {
        const text = event.transcript as string;
        if (text) {
          onTurnCompleteRef.current?.("user", text);
        }
      }

      // Tool call — execute server-side and return result
      if (type === "response.function_call_arguments.done") {
        const callId = event.call_id as string;
        const name = event.name as string;
        const argsStr = event.arguments as string;
        const conversationId = conversationIdRef.current;

        try {
          const res = await fetch("/api/realtime/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toolName: name,
              toolArgs: JSON.parse(argsStr || "{}"),
              ...(conversationId ? { conversationId, callId } : {}),
            }),
          });
          const data = await res.json();
          const output = data.success ? data.data.result : JSON.stringify({ error: data.error });

          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output,
            },
          });
          sendEvent({ type: "response.create" });

          if (conversationId) {
            onMessagesUpdatedRef.current?.();
          }
        } catch (e) {
          clientLog.error("Realtime tool execution failed", {
            toolName: name,
            callId,
            errorName: e instanceof Error ? e.name : "UnknownError",
            errorMessage: e instanceof Error ? e.message : "Unknown error",
          });
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

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  const connect = useCallback(async () => {
    if (connected || connecting) return;
    setConnecting(true);
    setError(null);
    intentionalDisconnectRef.current = false;

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

    let phase: "session" | "microphone" | "rtc-setup" | "sdp-exchange" = "session";
    try {
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

      phase = "rtc-setup";
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      // Detect unexpected connection drops (screen off, network loss, server timeout).
      // "disconnected" can self-recover so we only act on definitive states.
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          handleUnexpectedDisconnect();
        }
      };

      phase = "microphone";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      phase = "rtc-setup";
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        sendEvent({
          type: "session.update",
          session: {
            input_audio_transcription: { model: "whisper-1" },
          },
        });
      };

      dc.onmessage = (e) => handleDataChannelMessage(e.data as string);

      // Data channel close is the most reliable signal that the session has ended
      // (fires on network loss, server timeout, and screen-off on mobile).
      dc.onclose = () => handleUnexpectedDisconnect();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      phase = "sdp-exchange";
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
      // Keep the screen on for the duration of the session
      await acquireWakeLock();
    } catch (e) {
      const errName = e instanceof Error ? e.name : "UnknownError";
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      const online = typeof navigator !== "undefined" ? navigator.onLine : null;

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
      } else if (errMsg === "Failed to fetch" || errMsg === "NetworkError when attempting to fetch resource.") {
        msg = online === false ? "Network error: you appear to be offline" : "Network error: could not reach the server";
      } else {
        msg = errMsg;
      }

      clientLog.error("Realtime connect failed", {
        phase,
        errorName: errName,
        errorMessage: errMsg,
        online,
        modelId,
      });
      setError(msg);
      pcRef.current?.close();
      pcRef.current = null;
    } finally {
      setConnecting(false);
    }
  }, [modelId, connected, connecting, handleDataChannelMessage, sendEvent, acquireWakeLock, handleUnexpectedDisconnect]);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    releaseWakeLock();
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
  }, [releaseWakeLock]);

  return { connected, connecting, connect, disconnect, error };
}
