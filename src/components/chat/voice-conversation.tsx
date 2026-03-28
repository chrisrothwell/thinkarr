"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Mic, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAudioLevel } from "@/hooks/use-audio-level";
import { useSilenceDetection } from "@/hooks/use-silence-detection";
import { useTts } from "@/hooks/use-tts";

type VoicePhase = "idle" | "listening" | "processing" | "speaking";

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

  const { recording, transcribing, startRecording, stopAndTranscribe, cancelRecording, error, stream } =
    useVoiceInput();
  const bars = useAudioLevel(recording ? stream : null);
  const { speaking, speakText, stop: stopTts } = useTts(modelId);

  // Shared stop-listening logic used by both the manual button and auto-stop
  const handleStopListening = useCallback(async () => {
    const text = await stopAndTranscribe(modelId);
    if (text) {
      onSend(text);
      // phase transitions to "processing" via the transcribing useEffect
    } else {
      setPhase("idle");
    }
  }, [stopAndTranscribe, modelId, onSend]);

  const { secondsRemaining } = useSilenceDetection({
    stream: recording ? stream : null,
    onAutoStop: handleStopListening,
  });

  // Track what we've already spoken so we don't replay the same response
  const lastSpokenRef = useRef<string>("");
  // Track previous speaking value to detect the natural end of playback
  const prevSpeakingRef = useRef(false);

  // Transition from listening → processing when transcription starts
  useEffect(() => {
    if (transcribing && phase === "listening") setPhase("processing");
  }, [transcribing, phase]);

  // When streaming ends and we're waiting for a response, trigger TTS
  useEffect(() => {
    if (
      !streaming &&
      phase === "processing" &&
      lastResponse &&
      lastResponse !== lastSpokenRef.current
    ) {
      lastSpokenRef.current = lastResponse;
      setPhase("speaking");
      speakText(lastResponse, ttsVoice);
    }
  }, [streaming, phase, lastResponse, ttsVoice, speakText]);

  // When TTS finishes naturally, return to idle ready for next question
  useEffect(() => {
    if (prevSpeakingRef.current && !speaking && phase === "speaking") {
      setPhase("idle");
    }
    prevSpeakingRef.current = speaking;
  }, [speaking, phase]);

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
    // Move phase first so the speaking-end effect doesn't fire and override
    setPhase("listening");
    stopTts();
    await startRecording();
  }, [stopTts, startRecording]);

  const handleCancel = useCallback(() => {
    if (recording) cancelRecording();
    stopTts();
    onCancel();
  }, [recording, cancelRecording, stopTts, onCancel]);

  const isListening = phase === "listening";
  const isProcessing = phase === "processing";
  const isSpeaking = phase === "speaking";

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
        {phase === "idle" && "Tap to speak"}
        {phase === "listening" && (
          secondsRemaining !== null
            ? `Sending in ${secondsRemaining}s\u2026`
            : "Listening\u2026 tap to stop"
        )}
        {phase === "processing" && "Thinking\u2026"}
        {phase === "speaking" && "Speaking\u2026"}
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
