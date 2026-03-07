export type TitleMediaType = "movie" | "tv" | "episode";
export type TitleMediaStatus = "available" | "partial" | "pending" | "not_requested";

export interface DisplayTitle {
  mediaType: TitleMediaType;
  title: string;
  year?: number;
  summary?: string;
  rating?: number;
  thumbUrl?: string;        // full URL with token — built server-side
  plexKey?: string;
  plexUrl?: string;         // base Plex URL (no token) for web deep links
  plexMachineId?: string;   // Plex server machineIdentifier — required for Watch Now URL
  overseerrId?: number;
  overseerrMediaType?: "movie" | "tv";
  imdbId?: string;
  mediaStatus: TitleMediaStatus;
  cast?: string[];
  airDate?: string;
  // Episode-specific
  showTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}
