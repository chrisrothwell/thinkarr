import { describe, it, expect } from "vitest";
import { formatDisplayTitlesAsText } from "@/lib/tools/display-titles-text";
import type { DisplayTitle } from "@/types/titles";

function title(overrides: Partial<DisplayTitle> & { title: string; mediaStatus: DisplayTitle["mediaStatus"] }): DisplayTitle {
  return { mediaType: "movie", year: 2024, ...overrides };
}

describe("formatDisplayTitlesAsText", () => {
  it("marks available titles with a checkmark", () => {
    const { text, requestableItems } = formatDisplayTitlesAsText([
      title({ title: "Alien", mediaStatus: "available" }),
    ]);
    expect(text).toContain("✓ Available in Plex");
    expect(requestableItems).toHaveLength(0);
  });

  it("marks partial titles correctly", () => {
    const { text } = formatDisplayTitlesAsText([
      title({ title: "The Sopranos", mediaType: "tv", mediaStatus: "partial" }),
    ]);
    expect(text).toContain("✓ Partially available in Plex");
  });

  it("marks pending titles with a clock", () => {
    const { text } = formatDisplayTitlesAsText([
      title({ title: "Off Campus", mediaStatus: "pending" }),
    ]);
    expect(text).toContain("⏳ Already requested, downloading");
  });

  it("numbers requestable titles and adds them to requestableItems", () => {
    const { text, requestableItems } = formatDisplayTitlesAsText([
      title({ title: "Alien: Covenant", mediaStatus: "not_requested", overseerrId: 101, overseerrMediaType: "movie" }),
      title({ title: "Prometheus", mediaStatus: "not_requested", overseerrId: 102, overseerrMediaType: "movie" }),
    ]);
    expect(text).toContain("[1] *Alien: Covenant*");
    expect(text).toContain("[2] *Prometheus*");
    expect(text).toContain('reply with its number');
    expect(requestableItems).toHaveLength(2);
    expect(requestableItems[0]).toMatchObject({ overseerrId: 101, mediaType: "movie", title: "Alien: Covenant" });
    expect(requestableItems[1]).toMatchObject({ overseerrId: 102, mediaType: "movie", title: "Prometheus" });
  });

  it("assigns correct seasonNumber to TV season cards", () => {
    const { requestableItems } = formatDisplayTitlesAsText([
      title({
        title: "Off Campus — Season 1",
        mediaType: "tv",
        mediaStatus: "not_requested",
        overseerrId: 200,
        overseerrMediaType: "tv",
        seasonNumber: 1,
      }),
    ]);
    expect(requestableItems[0].seasonNumber).toBe(1);
  });

  it("omits requestable prompt when no requestable items exist", () => {
    const { text, requestableItems } = formatDisplayTitlesAsText([
      title({ title: "Alien", mediaStatus: "available" }),
      title({ title: "The Office", mediaType: "tv", mediaStatus: "pending" }),
    ]);
    expect(text).not.toContain("reply with its number");
    expect(requestableItems).toHaveLength(0);
  });

  it("skips not_requested titles without an overseerrId (no Request button possible)", () => {
    const { text, requestableItems } = formatDisplayTitlesAsText([
      title({ title: "Orphan Film", mediaStatus: "not_requested" }),
    ]);
    expect(text).not.toContain("[1]");
    expect(requestableItems).toHaveLength(0);
  });

  it("includes year in label when present", () => {
    const { text } = formatDisplayTitlesAsText([
      title({ title: "Dune", year: 2021, mediaStatus: "available" }),
    ]);
    expect(text).toContain("*Dune* (2021)");
  });

  it("handles mixed statuses with correct numbering", () => {
    const { text, requestableItems } = formatDisplayTitlesAsText([
      title({ title: "A", mediaStatus: "available" }),
      title({ title: "B", mediaStatus: "not_requested", overseerrId: 1, overseerrMediaType: "movie" }),
      title({ title: "C", mediaStatus: "pending" }),
      title({ title: "D", mediaStatus: "not_requested", overseerrId: 2, overseerrMediaType: "movie" }),
    ]);
    expect(text).toContain("[1] *B*");
    expect(text).toContain("[2] *D*");
    expect(requestableItems).toHaveLength(2);
  });
});
