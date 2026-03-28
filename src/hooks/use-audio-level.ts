"use client";

import { useEffect, useRef, useState } from "react";

const BAR_COUNT = 7;
// Sample every 3rd animation frame (~20 fps) to avoid excessive React renders
const FRAME_SKIP = 3;

/**
 * Returns an array of BAR_COUNT normalised bar heights (0–1) driven by a live
 * MediaStream's audio frequency data. All bars are 0 when stream is null.
 */
export function useAudioLevel(stream: MediaStream | null): number[] {
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(0));
  const rafRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);

  useEffect(() => {
    if (!stream) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const bucketSize = Math.max(1, Math.floor(dataArray.length / BAR_COUNT));
    frameCountRef.current = 0;

    function tick() {
      rafRef.current = requestAnimationFrame(tick);
      if (++frameCountRef.current % FRAME_SKIP !== 0) return;

      analyser.getByteFrequencyData(dataArray);
      const newBars: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, dataArray.length);
        for (let j = start; j < end; j++) sum += dataArray[j];
        newBars.push((sum / bucketSize) / 255);
      }
      setBars(newBars);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      void ctx.close();
    };
  }, [stream]);

  return bars;
}
