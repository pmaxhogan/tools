import { describe, expect, it } from "vitest";
import {
  buildRecorderOptions,
  estimateSize,
  extForMime,
  mp4RemuxArgs,
  MIME_CANDIDATES,
  pickMimeType,
  QUALITY,
  recordingFilename,
  run,
} from "./index";

describe("pickMimeType", () => {
  it("picks the most specific supported candidate for the preferred key", () => {
    const supportsEverything = () => true;
    expect(pickMimeType("webm-vp9", supportsEverything)).toBe("video/webm;codecs=vp9,opus");
  });

  it("falls back within the preferred list when only the bare container is supported", () => {
    const onlyBareWebm = (m: string) => m === "video/webm";
    expect(pickMimeType("webm-vp9", onlyBareWebm)).toBe("video/webm");
  });

  it("falls back to another preference's candidates when the preferred key has no support", () => {
    const onlyBareWebm = (m: string) => m === "video/webm";
    // mp4 candidates never match; should fall through to a webm-* list's bare container.
    expect(pickMimeType("mp4", onlyBareWebm)).toBe("video/webm");
  });

  it("returns the last-resort mime when nothing at all is supported", () => {
    expect(pickMimeType("webm-vp9", () => false)).toBe("video/webm");
  });

  it("treats an unknown preference key like webm-vp9", () => {
    const supportsEverything = () => true;
    expect(pickMimeType("bogus-key", supportsEverything)).toBe(MIME_CANDIDATES["webm-vp9"]![0]);
  });
});

describe("extForMime", () => {
  it("returns mp4 for mp4 mimes", () => {
    expect(extForMime("video/mp4;codecs=avc1,mp4a")).toBe("mp4");
    expect(extForMime("video/mp4")).toBe("mp4");
  });

  it("returns webm for webm and unknown mimes", () => {
    expect(extForMime("video/webm;codecs=vp9,opus")).toBe("webm");
    expect(extForMime("")).toBe("webm");
  });
});

describe("recordingFilename", () => {
  it("formats an injected date deterministically", () => {
    const date = new Date(2026, 7, 18, 14, 30, 5); // months are 0-indexed: August
    expect(recordingFilename({ ext: "webm", date })).toBe(
      "screen-recording-2026-08-18-143005.webm",
    );
  });

  it("pads single-digit month/day/time components", () => {
    const date = new Date(2026, 0, 5, 9, 2, 3);
    expect(recordingFilename({ ext: "mp4", date })).toBe("screen-recording-2026-01-05-090203.mp4");
  });

  it("honors a custom prefix", () => {
    const date = new Date(2026, 7, 18, 14, 30, 5);
    expect(recordingFilename({ prefix: "clip", ext: "webm", date })).toBe(
      "clip-2026-08-18-143005.webm",
    );
  });
});

describe("estimateSize", () => {
  it("computes bytes from kbps and seconds", () => {
    // 8000 kbps for 60s = 8000 * 1000 / 8 * 60 = 60,000,000 bytes
    expect(estimateSize(8000, 60)).toBe(60_000_000);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(estimateSize(0, 60)).toBe(0);
    expect(estimateSize(-5, 60)).toBe(0);
    expect(estimateSize(1000, 0)).toBe(0);
  });
});

describe("buildRecorderOptions", () => {
  it("maps a known quality preset to videoBitsPerSecond", () => {
    const opts = buildRecorderOptions({ quality: "720p", mimeType: "video/webm" });
    const preset = QUALITY.find((q) => q.id === "720p")!;
    expect(opts.mimeType).toBe("video/webm");
    expect(opts.videoBitsPerSecond).toBe(preset.videoKbps * 1000);
    expect(opts.audioBitsPerSecond).toBeUndefined();
  });

  it("adds audioBitsPerSecond when mic or system audio is requested", () => {
    const withMic = buildRecorderOptions({
      quality: "1080p",
      mimeType: "video/webm",
      micAudio: true,
    });
    expect(withMic.audioBitsPerSecond).toBe(128_000);

    const withSystem = buildRecorderOptions({
      quality: "1080p",
      mimeType: "video/webm",
      systemAudio: true,
    });
    expect(withSystem.audioBitsPerSecond).toBe(128_000);
  });

  it("falls back to a default preset for an unknown quality id", () => {
    const opts = buildRecorderOptions({ quality: "nonsense", mimeType: "video/webm" });
    expect(opts.videoBitsPerSecond).toBeGreaterThan(0);
  });
});

describe("mp4RemuxArgs", () => {
  it("builds the expected ffmpeg argument shape", () => {
    expect(mp4RemuxArgs("in.webm", "out.mp4")).toEqual([
      "-i",
      "in.webm",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "out.mp4",
    ]);
  });
});

describe("run", () => {
  it("summarizes a webm recording with no audio", () => {
    const out = run("", {
      quality: "720p",
      format: "webm",
      micAudio: false,
      systemAudio: false,
    });
    expect(out["Audio sources"]).toBe("none");
    expect(out["Recording format"]).toContain("WebM");
    expect(out["Quality"]).toContain("720p");
  });

  it("summarizes an mp4 target with both audio sources enabled", () => {
    const out = run("", {
      quality: "1080p-high",
      format: "mp4",
      micAudio: true,
      systemAudio: true,
    });
    expect(out["Audio sources"]).toBe("microphone + system/tab audio");
    expect(out["Recording format"]).toContain("MP4");
    expect(out["Estimated size for 60s"]).toMatch(/MB|GB/);
  });

  it("never touches the DOM or throws for missing input", () => {
    expect(() =>
      run(undefined as unknown as string, {
        quality: "low",
        format: "webm",
        micAudio: false,
        systemAudio: true,
      }),
    ).not.toThrow();
  });
});
