import { describe, it, expect } from "vitest";
import { OUTPUT_FORMATS, formatInfo } from "./formats";

describe("output formats", () => {
  it("exposes mp4/mov/mkv/webm with ids matching their extensions", () => {
    const ids = OUTPUT_FORMATS.map((f) => f.id);
    expect(ids).toEqual(["mp4", "mov", "mkv", "webm"]);
  });

  it("marks only WebM as non-H.264", () => {
    expect(formatInfo("mp4").h264).toBe(true);
    expect(formatInfo("mov").h264).toBe(true);
    expect(formatInfo("mkv").h264).toBe(true);
    expect(formatInfo("webm").h264).toBe(false);
  });

  it("carries a codec detail hint", () => {
    expect(formatInfo("mp4").detail).toBe("H.264 · AAC");
    expect(formatInfo("webm").detail).toBe("VP9 · Opus");
  });

  it("defaults unknown ids to MP4", () => {
    expect(formatInfo("gif").id).toBe("mp4");
    expect(formatInfo("").id).toBe("mp4");
  });
});
