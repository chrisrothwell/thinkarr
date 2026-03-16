"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TitleCard } from "./title-card";
import type { DisplayTitle } from "@/types/titles";

interface TitleCarouselProps {
  titles: DisplayTitle[];
}

export function TitleCarousel({ titles }: TitleCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (titles.length === 1) {
    return (
      <div className="max-w-md">
        <TitleCard title={titles[0]} />
      </div>
    );
  }

  function scroll(dir: "left" | "right") {
    if (!scrollRef.current) return;
    const amount = 352 + 12; // card width + gap
    scrollRef.current.scrollBy({ left: dir === "right" ? amount : -amount, behavior: "smooth" });
  }

  return (
    <div className="relative group w-full">
      {/* Left arrow — always visible on mobile, hover-reveal on desktop */}
      <button
        onClick={() => scroll("left")}
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-card border border-border shadow-sm hover:bg-muted transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Scroll left"
      >
        <ChevronLeft size={18} />
      </button>

      {/* Scrollable container */}
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory [&::-webkit-scrollbar]:hidden pb-1"
      >
        {titles.map((t, i) => (
          <div key={i} className="w-[352px] shrink-0 snap-start">
            <TitleCard title={t} />
          </div>
        ))}
      </div>

      {/* Right arrow — always visible on mobile, hover-reveal on desktop */}
      <button
        onClick={() => scroll("right")}
        className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-card border border-border shadow-sm hover:bg-muted transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Scroll right"
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
