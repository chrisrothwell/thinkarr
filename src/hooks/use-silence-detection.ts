"use client";

import { useEffect, useRef, useState } from "react";

const SILENCE_THRESHOLD = 0.05; // normalised amplitude below which we consider it silent
const SILENCE_DURATION_MS = 1500; // sustained silence before auto-stop
const MIN_RECORDING_MS = 500; // don't trigger silence detection before this
const MAX_RECORDING_MS = 60_000; // hard timeout regardless of noise
const COUNTDOWN_START_S = 10; // show countdown label in the last N seconds

interface UseSilenceDetectionOptions {
  /** Pass the live MediaStream while recording; null to disable. */
  stream: MediaStream | null;
  /** Called once when either silence or the hard timeout fires. */
  onAutoStop: () => void;
}

interface UseSilenceDetectionResult {
  /**
   * Non-null (and counting down) only during the last COUNTDOWN_START_S
   * seconds of the hard timeout. Use this to show "Sending in Xs…".
   */
  secondsRemaining: number | null;
}

export function useSilenceDetection({
  stream,
  onAutoStop,
}: UseSilenceDetectionOptions): UseSilenceDetectionResult {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  // Keep a stable ref to the latest callback so the rAF loop never captures
  // a stale closure without needing to be recreated.
  const onAutoStopRef = useRef(onAutoStop);
  useEffect(() => {
    onAutoStopRef.current = onAutoStop;
  }, [onAutoStop]);

  useEffect(() => {
    if (!stream) return;

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const startTime = performance.now();
    let silenceSince: number | null = null;
    let rafId: number;
    let fired = false;

    function fire() {
      if (fired) return;
      fired = true;
      onAutoStopRef.current();
    }

    // Hard timeout — fires even in a noisy room
    const maxTimer = setTimeout(fire, MAX_RECORDING_MS);

    // Countdown ticker — updates state every 500ms so the label stays accurate
    const countdownInterval = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const remaining = Math.ceil((MAX_RECORDING_MS - elapsed) / 1000);
      setSecondsRemaining(remaining > 0 && remaining <= COUNTDOWN_START_S ? remaining : null);
    }, 500);

    function tick() {
      rafId = requestAnimationFrame(tick);

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const level = sum / dataArray.length / 255;

      const now = performance.now();

      // Ignore silence during the initial minimum window
      if (now - startTime < MIN_RECORDING_MS) {
        silenceSince = null;
        return;
      }

      if (level < SILENCE_THRESHOLD) {
        if (silenceSince === null) silenceSince = now;
        else if (now - silenceSince >= SILENCE_DURATION_MS) fire();
      } else {
        silenceSince = null;
      }
    }

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(maxTimer);
      clearInterval(countdownInterval);
      source.disconnect();
      void ctx.close();
      setSecondsRemaining(null);
    };
  }, [stream]);

  // When stream is null return null directly — avoids setState in effect body
  return { secondsRemaining: stream ? secondsRemaining : null };
}
