"use client";

import { useState } from "react";
import { Star, Film, Tv } from "lucide-react";
import type { DisplayTitle } from "@/types/titles";
import { clientLog } from "@/lib/client-logger";

interface TitleCardProps {
  title: DisplayTitle;
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  available: { label: "Available", className: "bg-green-500/20 text-green-400 border border-green-500/30" },
  partial: { label: "Partial", className: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
  pending: { label: "Pending", className: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
  not_requested: { label: "Not Requested", className: "bg-muted text-muted-foreground border border-border" },
};

function requestedStorageKey(overseerrId: number, mediaType: string, seasonNumber?: number | null): string {
  const base = `thinkarr:requested:${mediaType}:${overseerrId}`;
  return seasonNumber != null ? `${base}:s${seasonNumber}` : base;
}

export function TitleCard({ title }: TitleCardProps) {
  const [requesting, setRequesting] = useState(false);
  const storageKey = title.overseerrId != null && title.overseerrMediaType
    ? requestedStorageKey(title.overseerrId, title.overseerrMediaType, title.seasonNumber)
    : null;
  const [requestStatus, setRequestStatus] = useState<"idle" | "success" | "error">(() => {
    if (storageKey && typeof localStorage !== "undefined") {
      try { return localStorage.getItem(storageKey) === "1" ? "success" : "idle"; } catch { /* ignore */ }
    }
    return "idle";
  });
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
        if (storageKey) {
          try { localStorage.setItem(storageKey, "1"); } catch { /* ignore */ }
        }
        setRequestStatus("success");
      } else {
        setErrorMsg(data.error ?? "Request failed");
        setRequestStatus("error");
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      clientLog.error("Title card request failed", {
        errorName: e instanceof Error ? e.name : "UnknownError",
        errorMessage: errMsg,
        online: typeof navigator !== "undefined" ? navigator.onLine : null,
        title: title.title,
        overseerrId: title.overseerrId,
      });
      setErrorMsg(
        errMsg === "Failed to fetch" || errMsg === "NetworkError when attempting to fetch resource."
          ? "Network error — could not reach the server"
          : errMsg,
      );
      setRequestStatus("error");
    } finally {
      setRequesting(false);
    }
  }

  // "partial" means the show is already in Overseerr (fully requested, new episodes pending).
  // Never offer a request button for partial — only for truly not-yet-requested titles.
  const showRequestButton =
    title.mediaStatus === "not_requested" &&
    title.overseerrId != null &&
    title.overseerrMediaType != null;

  // More Info: prefer IMDb, fall back to TMDB direct page, then Google search.
  // Always produces a non-null href so the button is always visible.
  // For TV shows/episodes without an external ID, search by showTitle (not the full
  // "Show — Season N" title) so the Google query is clean and useful.
  const moreInfoHref = title.imdbId
    ? `https://www.imdb.com/title/${title.imdbId}`
    : title.overseerrId && title.overseerrMediaType
      ? `https://www.themoviedb.org/${title.overseerrMediaType === "movie" ? "movie" : "tv"}/${title.overseerrId}`
      : `https://www.google.com/search?q=${encodeURIComponent(
          (title.mediaType === "tv" || title.mediaType === "episode") && title.showTitle
            ? title.showTitle
            : title.title,
        )}`;

  return (
    <div className="flex gap-3 rounded-xl border border-border bg-card p-3 w-full" data-testid="title-card">
      {/* Thumbnail */}
      {title.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={title.thumbUrl}
          alt={displayTitle}
          className="w-24 h-36 object-cover rounded-lg shrink-0 bg-muted"
        />
      ) : (
        <div className="w-24 h-36 rounded-lg shrink-0 bg-muted flex items-center justify-center text-muted-foreground/40">
          {title.mediaType === "movie" ? <Film size={32} /> : <Tv size={32} />}
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
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${status.className}`} data-testid="title-status">
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
          {/* Watch Now — available or partial titles that have a Plex URL */}
          {(title.mediaStatus === "available" || title.mediaStatus === "partial") && plexWebUrl && (
            <a
              href={plexWebUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium whitespace-nowrap"
              data-testid="watch-now-button"
            >
              Watch Now
            </a>
          )}

          {/* Request — not_requested titles with an Overseerr ID */}
          {showRequestButton && requestStatus === "idle" && (
            <button
              onClick={handleRequest}
              disabled={requesting}
              className="text-xs px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium disabled:opacity-50 flex items-center gap-1 whitespace-nowrap"
              data-testid="request-button"
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

          {showRequestButton && requestStatus === "success" && (
            <span className="text-xs px-3 py-1 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30 font-medium whitespace-nowrap" data-testid="request-success">
              Requested
            </span>
          )}

          {showRequestButton && requestStatus === "error" && (
            <span className="text-xs text-destructive whitespace-nowrap">{errorMsg}</span>
          )}

          {/* More Info — always shown; prefers IMDb → TMDB direct → Google search */}
          <a
            href={moreInfoHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors font-medium whitespace-nowrap"
            data-testid="more-info-button"
          >
            More Info
          </a>
        </div>
      </div>
    </div>
  );
}
