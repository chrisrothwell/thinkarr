"use client";

import { useCallback } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useVoiceInput } from "@/hooks/use-voice-input";

interface VoiceInputProps {
  modelId: string;
  transcriptionLanguage?: string;
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export function VoiceInput({ modelId, transcriptionLanguage = "auto", onTranscript, disabled }: VoiceInputProps) {
  const { recording, transcribing, startRecording, stopAndTranscribe, error } = useVoiceInput();

  const handleToggle = useCallback(async () => {
    if (recording) {
      const text = await stopAndTranscribe(modelId, transcriptionLanguage);
      if (text) onTranscript(text);
    } else {
      await startRecording();
    }
  }, [recording, modelId, transcriptionLanguage, onTranscript, startRecording, stopAndTranscribe]);

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <Button
        size="lg"
        variant={recording ? "destructive" : "secondary"}
        onClick={handleToggle}
        disabled={disabled || transcribing}
        className="h-16 w-16 rounded-full"
      >
        {transcribing ? (
          <Spinner size={24} />
        ) : recording ? (
          <Square size={24} />
        ) : (
          <Mic size={24} />
        )}
      </Button>

      <p className="text-sm text-muted-foreground">
        {transcribing
          ? "Transcribing..."
          : recording
          ? "Recording — click to stop and send"
          : "Click to record"}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
