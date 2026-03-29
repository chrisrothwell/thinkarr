"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Mic, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAudioLevel } from "@/hooks/use-audio-level";
import { useSilenceDetection } from "@/hooks/use-silence-detection";
import { useTts } from "@/hooks/use-tts";

// "speaking" is derived from useTts rather than tracked as explicit phase state,
// so the state machine only needs three stored values.
type VoicePhase = "idle" | "listening" | "processing";

interface VoiceConversationProps {
  modelId: string;
  ttsVoice?: string;
  /** Called when transcription completes — sends the query to the chat */
  onSend: (text: string) => void;
  /** Called when the user explicitly exits voice mode */
  onCancel: () => void;
  /** True while the LLM is streaming its response */
  streaming: boolean;
  /** Full text of the latest assistant message — triggers TTS when streaming ends */
  lastResponse: string;
}

export function VoiceConversation({
  modelId,
  ttsVoice = "alloy",
  onSend,
  onCancel,
  streaming,
  lastResponse,
}: VoiceConversationProps) {
  const [phase, setPhase] = useState<VoicePhase>("idle");

  const { recording, startRecording, stopAndTranscribe, cancelRecording, error, stream } =
    useVoiceInput();
  const bars = useAudioLevel(recording ? stream : null);
  const { speaking, speakText, stop: stopTts } = useTts(modelId);

  // Keep stable refs so the unmount cleanup can read the latest values
  // without needing them as effect dependencies.
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const cancelRecordingRef = useRef(cancelRecording);
  cancelRecordingRef.current = cancelRecording;
  const stopTtsRef = useRef(stopTts);
  stopTtsRef.current = stopTts;

  // Release mic and stop TTS when the component unmounts (mode change,
  // conversation switch, new chat, etc.) so resources are not held after
  // the user navigates away from voice mode.
  useEffect(() => {
    return () => {
      if (recordingRef.current) cancelRecordingRef.current();
      stopTtsRef.current();
    };
  }, []);

  // Derive the full 4-value phase for the UI without storing "speaking" in state.
  // This avoids calling setPhase synchronously inside effects (react-hooks/set-state-in-effect).
  const effectivePhase = speaking ? "speaking" : phase;

  // Track what we've already spoken so we don't replay the same response
  const lastSpokenRef = useRef<string>("");

  // Shared stop-listening logic for both the manual button tap and silence-detection auto-stop.
  // Sets phase to "processing" immediately (before the async transcription) so the UI
  // transitions away from the listening state without needing a separate effect.
  const handleStopListening = useCallback(async () => {
    setPhase("processing");
    const text = await stopAndTranscribe(modelId);
    if (text) {
      onSend(text);
    } else {
      setPhase("idle");
    }
  }, [stopAndTranscribe, modelId, onSend]);

  const { secondsRemaining } = useSilenceDetection({
    stream: recording ? stream : null,
    onAutoStop: handleStopListening,
  });

  // When the LLM finishes streaming while we're waiting for a response, read it aloud.
  // setPhase("idle") is called inside the promise .then() callback (async, not synchronous
  // in the effect body) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (
      !streaming &&
      phase === "processing" &&
      lastResponse &&
      lastResponse !== lastSpokenRef.current
    ) {
      lastSpokenRef.current = lastResponse;
      let cancelled = false;
      speakText(lastResponse, ttsVoice).then(() => {
        if (!cancelled) setPhase("idle");
      });
      return () => {
        cancelled = true;
      };
    }
  }, [streaming, phase, lastResponse, ttsVoice, speakText]);

  const handleMicToggle = useCallback(async () => {
    if (phase === "idle") {
      await startRecording();
      if (!error) setPhase("listening");
    } else if (phase === "listening") {
      await handleStopListening();
    }
  }, [phase, startRecording, error, handleStopListening]);

  // Skip current TTS and start a new recording immediately
  const handleAskAgain = useCallback(async () => {
    setPhase("listening"); // show listening UI before mic opens
    stopTts();             // sets speaking=false; effectivePhase becomes "listening"
    await startRecording();
  }, [stopTts, startRecording]);

  const handleCancel = useCallback(() => {
    if (recording) cancelRecording();
    stopTts();
    onCancel();
  }, [recording, cancelRecording, stopTts, onCancel]);

  const isListening = effectivePhase === "listening";
  const isProcessing = effectivePhase === "processing";
  const isSpeaking = effectivePhase === "speaking";

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      {/* Central visual element */}
      <div className="relative flex items-center justify-center">
        {/* Animated ping ring for listening / speaking states */}
        {(isListening || isSpeaking) && (
          <span className="absolute h-20 w-20 rounded-full animate-ping opacity-20 bg-primary" />
        )}

        {isProcessing ? (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Spinner size={32} />
          </div>
        ) : isSpeaking ? (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Volume2 size={28} />
          </div>
        ) : (
          <Button
            size="lg"
            variant={isListening ? "destructive" : "secondary"}
            onClick={handleMicToggle}
            className="relative z-10 h-16 w-16 rounded-full"
          >
            <Mic size={28} />
          </Button>
        )}
      </div>

      {/* Real-time audio level bars — only shown while recording */}
      {isListening && (
        <div className="flex h-8 items-end gap-1">
          {bars.map((level, i) => (
            <div
              key={i}
              className="w-1.5 rounded-full bg-primary transition-all duration-75"
              style={{ height: `${Math.max(4, level * 32)}px` }}
            />
          ))}
        </div>
      )}

      {/* Status label */}
      <p className="text-sm text-muted-foreground">
        {effectivePhase === "idle" && "Tap to speak"}
        {effectivePhase === "listening" && (
          secondsRemaining !== null
            ? `Sending in ${secondsRemaining}s\u2026`
            : "Listening\u2026 tap to stop"
        )}
        {effectivePhase === "processing" && "Thinking\u2026"}
        {effectivePhase === "speaking" && "Speaking\u2026"}
      </p>

      {/* Action buttons */}
      <div className="flex items-center gap-4">
        {isSpeaking && (
          <Button size="sm" variant="secondary" onClick={handleAskAgain} className="gap-1.5">
            <Mic size={14} />
            Ask again
          </Button>
        )}
        <button
          onClick={handleCancel}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {isSpeaking ? "Cancel" : "Exit voice"}
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
