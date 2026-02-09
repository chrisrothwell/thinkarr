"use client";

import { useRef, useEffect, useCallback } from "react";

export function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Auto-scroll if user is within 100px of the bottom
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 100;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Scroll to bottom when deps change
  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      shouldAutoScroll.current = true;
    }
  }, []);

  return { containerRef, scrollToBottom };
}
