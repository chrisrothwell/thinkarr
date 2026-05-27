import type { DisplayTitle } from "@/types/titles";
import type { PendingItem } from "./pending-basket";

export interface TextChannelDisplay {
  text: string;
  requestableItems: PendingItem[];
}

/**
 * Convert a display_titles result to a plain-text representation for chat channels.
 * Requestable items (mediaStatus "not_requested") are numbered for confirm_request.
 */
export function formatDisplayTitlesAsText(titles: DisplayTitle[]): TextChannelDisplay {
  const requestableItems: PendingItem[] = [];
  const lines: string[] = [];
  let requestIndex = 0;

  for (const t of titles) {
    const yearStr = t.year ? ` (${t.year})` : "";
    const label = `*${t.title}*${yearStr}`;

    if (t.mediaStatus === "available") {
      lines.push(`${label} ✓ Available in Plex`);
    } else if (t.mediaStatus === "partial") {
      lines.push(`${label} ✓ Partially available in Plex`);
    } else if (t.mediaStatus === "pending") {
      lines.push(`${label} ⏳ Already requested, downloading`);
    } else {
      // not_requested — include in numbered list only if we have an overseerrId to request with
      if (t.overseerrId != null) {
        requestIndex++;
        lines.push(`[${requestIndex}] ${label} — Not in library`);
        requestableItems.push({
          overseerrId: t.overseerrId,
          mediaType: t.overseerrMediaType ?? (t.mediaType === "movie" ? "movie" : "tv"),
          ...(t.seasonNumber != null ? { seasonNumber: t.seasonNumber } : {}),
          title: t.title,
        });
      } else {
        lines.push(`${label} — Not in library`);
      }
    }
  }

  let text = lines.join("\n");
  if (requestableItems.length > 0) {
    text += '\n\nTo request a title, reply with its number (e.g. "request 1").';
  }

  return { text, requestableItems };
}
