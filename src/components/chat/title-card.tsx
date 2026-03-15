"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import type { DisplayTitle } from "@/types/titles";

interface TitleCardProps {
  title: DisplayTitle;
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  available: { label: "Available", className: "bg-green-500/20 text-green-400 border border-green-500/30" },
  partial: { label: "Partial", className: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
  pending: { label: "Pending", className: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
  not_requested: { label: "Not Requested", className: "bg-muted text-muted-foreground border border-border" },
};

export function TitleCard({ title }: TitleCardProps) {
  const [requesting, setRequesting] = useState(false);
  const [requestStatus, setRequestStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const status = STATUS_STYLES[title.mediaStatus] ?? STATUS_STYLES.not_requested;

  const episodeLabel =
    title.mediaType === "episode" && title.seasonNumber != null && title.episodeNumber != null
      ? `S${String(title.seasonNumber).padStart(2, "0")}E${String(title.episodeNumber).padStart(2, "0")} — `
      : "";

  const displayTitle = title.mediaType === "episode" && title.showTitle
    ? title.showTitle
    : title.title;

  const subTitle = title.mediaType === "episode"
    ? `${episodeLabel}${title.title}`
    : title.year
    ? String(title.year)
    : undefined;

  // Use app.plex.tv universal link — works externally and opens native app on iOS/Android.
  // Strip /children from key so the link opens the title details, not the children list.
  const plexWebUrl =
    title.plexKey && title.plexMachineId
      ? `https://app.plex.tv/desktop/#!/server/${title.plexMachineId}/details?key=${encodeURIComponent(title.plexKey.replace(/\/children\/?$/, ""))}`
      : undefined;

  async function handleRequest() {
    if (!title.overseerrId || !title.overseerrMediaType) return;
    setRequesting(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: title.overseerrId,
          mediaType: title.overseerrMediaType,
          ...(title.seasonNumber != null ? { seasons: [title.seasonNumber] } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setRequestStatus("success");
      } else {
        setErrorMsg(data.error ?? "Request failed");
        setRequestStatus("error");
      }
    } catch {
      setErrorMsg("Network error");
      setRequestStatus("error");
    } finally {
      setRequesting(false);
    }
  }

  const showRequestButton =
    (title.mediaStatus === "not_requested" || title.mediaStatus === "partial") &&
    title.overseerrId != null &&
    title.overseerrMediaType != null;

  return (
    <div className="flex gap-3 rounded-xl border border-border bg-card p-3 w-full">
      {/* Thumbnail */}
      {title.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={title.thumbUrl}
          alt={displayTitle}
          className="w-24 h-36 object-cover rounded-lg shrink-0 bg-muted"
        />
      ) : (
        <div className="w-24 h-36 rounded-lg shrink-0 bg-muted flex items-center justify-center text-muted-foreground text-xs text-center px-1">
          No Image
        </div>
      )}

      {/* Content */}
      <div className="flex flex-col min-w-0 flex-1 gap-1">
        {/* Title + year */}
        <div>
          <p className="font-semibold text-sm text-foreground leading-tight line-clamp-2">{displayTitle}</p>
          {subTitle && <p className="text-xs text-muted-foreground mt-0.5">{subTitle}</p>}
        </div>

        {/* Status badge + rating */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${status.className}`}>
            {status.label}
          </span>
          {title.rating != null && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Star size={11} className="text-amber-400 fill-amber-400" />
              {title.rating.toFixed(1)}
            </span>
          )}
        </div>

        {/* Summary */}
        {title.summary && (
          <p className="text-xs text-muted-foreground line-clamp-2">{title.summary}</p>
        )}

        {/* Cast */}
        {title.cast && title.cast.length > 0 && (
          <p className="text-xs text-muted-foreground truncate">
            {title.cast.slice(0, 4).join(", ")}
          </p>
        )}

        {/* Buttons */}
        <div className="flex flex-wrap gap-2 mt-auto pt-1">
          {title.mediaStatus === "available" && plexWebUrl && (
            <a
              href={plexWebUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
            >
              Watch Now
            </a>
          )}

          {showRequestButton && (title.imdbId || (title.overseerrId && title.overseerrMediaType)) && (
            <a
              href={
                title.imdbId
                  ? `https://www.imdb.com/title/${title.imdbId}`
                  : `https://www.themoviedb.org/${title.overseerrMediaType === "movie" ? "movie" : "tv"}/${title.overseerrId}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors font-medium"
            >
              More Info
            </a>
          )}

          {showRequestButton && requestStatus === "idle" && (
            <button
              onClick={handleRequest}
              disabled={requesting}
              className="text-xs px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium disabled:opacity-50 flex items-center gap-1"
            >
              {requesting ? (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Requesting…
                </>
              ) : (
                "Request"
              )}
            </button>
          )}

          {requestStatus === "success" && (
            <span className="text-xs px-3 py-1 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30 font-medium">
              Requested
            </span>
          )}

          {requestStatus === "error" && (
            <span className="text-xs text-destructive">{errorMsg}</span>
          )}
        </div>
      </div>
    </div>
  );
}
