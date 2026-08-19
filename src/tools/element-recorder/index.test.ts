import { describe, expect, it } from "vitest";
import {
  clampRegion,
  describeRecording,
  DEFAULT_MIME_CANDIDATES,
  estimateBitrate,
  extForMime,
  fileName,
  patchWebmDuration,
  pickMimeType,
  qualityMultiplier,
  regionFromPoints,
  run,
  snapToElementRect,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ *
 * pickMimeType / extForMime
 * ------------------------------------------------------------------ */

describe("pickMimeType", () => {
  it("picks the first candidate the support check accepts", () => {
    expect(pickMimeType(DEFAULT_MIME_CANDIDATES, () => true)).toBe("video/webm;codecs=vp9");
  });

  it("respects the given candidate order over the default preference", () => {
    const onlyVp9 = (m: string) => m === "video/webm;codecs=vp9";
    expect(pickMimeType(["video/mp4", "video/webm;codecs=vp9"], onlyVp9)).toBe(
      "video/webm;codecs=vp9",
    );
  });

  it("falls back through the list to whatever is supported", () => {
    const onlyMp4 = (m: string) => m === "video/mp4";
    expect(pickMimeType(DEFAULT_MIME_CANDIDATES, onlyMp4)).toBe("video/mp4");
  });

  it("uses the default candidates when none are given", () => {
    const onlyVp8 = (m: string) => m === "video/webm;codecs=vp8";
    expect(pickMimeType([], onlyVp8)).toBe("video/webm;codecs=vp8");
  });

  it("returns the last-resort mime when nothing is supported", () => {
    expect(pickMimeType(DEFAULT_MIME_CANDIDATES, () => false)).toBe("video/webm");
  });
});

describe("extForMime", () => {
  it("returns mp4 for mp4 mimes", () => {
    expect(extForMime("video/mp4;codecs=avc1,mp4a")).toBe("mp4");
    expect(extForMime("video/mp4")).toBe("mp4");
  });

  it("returns webm for webm and unrecognized mimes", () => {
    expect(extForMime("video/webm;codecs=vp9")).toBe("webm");
    expect(extForMime("")).toBe("webm");
  });
});

/* ------------------------------------------------------------------ *
 * fileName
 * ------------------------------------------------------------------ */

describe("fileName", () => {
  it("formats an injected date deterministically", () => {
    const date = new Date(2026, 7, 18, 14, 30, 5);
    expect(fileName("clip", "video/webm", date)).toBe("clip-2026-08-18-143005.webm");
  });

  it("falls back to a default prefix when empty", () => {
    const date = new Date(2026, 0, 5, 9, 2, 3);
    expect(fileName("", "video/mp4;codecs=avc1", date)).toBe(
      "element-recording-2026-01-05-090203.mp4",
    );
  });

  it("uses the current time when no date is injected", () => {
    expect(fileName("clip", "video/webm")).toMatch(/^clip-\d{4}-\d{2}-\d{2}-\d{6}\.webm$/);
  });
});

/* ------------------------------------------------------------------ *
 * quality / bitrate
 * ------------------------------------------------------------------ */

describe("qualityMultiplier", () => {
  it("maps the three quality values to increasing multipliers", () => {
    expect(qualityMultiplier("low")).toBe(0.5);
    expect(qualityMultiplier("medium")).toBe(1);
    expect(qualityMultiplier("high")).toBe(1.75);
  });

  it("defaults an unrecognized value to medium", () => {
    expect(qualityMultiplier("bogus")).toBe(1);
  });
});

describe("estimateBitrate", () => {
  it("increases monotonically with resolution and frame rate", () => {
    const small = estimateBitrate(1280, 720, 30);
    const bigger = estimateBitrate(1920, 1080, 30);
    const fastest = estimateBitrate(1920, 1080, 60);
    expect(small).toBeLessThan(bigger);
    expect(bigger).toBeLessThan(fastest);
  });

  it("clamps tiny regions to the minimum bitrate", () => {
    expect(estimateBitrate(10, 10, 5)).toBe(250_000);
  });

  it("clamps huge regions to the maximum bitrate", () => {
    expect(estimateBitrate(7680, 4320, 60)).toBe(20_000_000);
  });

  it("defaults an invalid frame rate to 30fps", () => {
    expect(estimateBitrate(1920, 1080, Number.NaN)).toBe(estimateBitrate(1920, 1080, 30));
  });
});

/* ------------------------------------------------------------------ *
 * region math
 * ------------------------------------------------------------------ */

describe("regionFromPoints", () => {
  it("normalizes a forward drag", () => {
    expect(regionFromPoints(10, 20, 110, 220)).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("normalizes a drag in any direction to the same rect", () => {
    expect(regionFromPoints(110, 220, 10, 20)).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("treats non-finite coordinates as 0", () => {
    expect(regionFromPoints(Number.NaN, 5, 10, 15)).toEqual({ x: 0, y: 5, width: 10, height: 10 });
  });
});

describe("clampRegion", () => {
  it("leaves a region already inside bounds unchanged", () => {
    const region = { x: 10, y: 10, width: 50, height: 50 };
    expect(clampRegion(region, { width: 200, height: 200 })).toEqual(region);
  });

  it("pulls a region back inside bounds it overflows on the bottom right", () => {
    const region = { x: 150, y: 150, width: 100, height: 100 };
    expect(clampRegion(region, { width: 200, height: 200 })).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
  });

  it("shrinks a region larger than the bounds", () => {
    const region = { x: 0, y: 0, width: 300, height: 300 };
    expect(clampRegion(region, { width: 200, height: 200 })).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it("clamps negative coordinates back to the bounds origin", () => {
    const region = { x: -50, y: -50, width: 50, height: 50 };
    expect(clampRegion(region, { width: 200, height: 200 })).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
  });

  it("honors an offset bounds origin", () => {
    const region = { x: 5, y: 5, width: 50, height: 50 };
    expect(clampRegion(region, { x: 100, y: 100, width: 200, height: 200 })).toEqual({
      x: 100,
      y: 100,
      width: 50,
      height: 50,
    });
  });
});

describe("snapToElementRect", () => {
  it("passes through whole-pixel rects at dpr 1", () => {
    expect(snapToElementRect({ x: 10, y: 10, width: 100, height: 50 }, 1)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    });
  });

  it("rounds edges independently at a fractional dpr scale", () => {
    expect(snapToElementRect({ x: 10.4, y: 10.4, width: 100.2, height: 50.6 }, 2)).toEqual({
      x: 21,
      y: 21,
      width: 200,
      height: 101,
    });
  });

  it("falls back to a dpr of 1 for an invalid ratio", () => {
    const rect = { x: 5, y: 5, width: 10, height: 10 };
    expect(snapToElementRect(rect, -1)).toEqual(snapToElementRect(rect, 1));
  });
});

/* ------------------------------------------------------------------ *
 * describeRecording
 * ------------------------------------------------------------------ */

describe("describeRecording", () => {
  it("summarizes a full report", () => {
    const out = describeRecording({
      bytes: 5_000_000,
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      mimeType: "video/webm;codecs=vp9",
      fps: 30,
    });
    expect(out["Size"]).toMatch(/MB/);
    expect(out["Duration"]).toBe("0:10");
    expect(out["Frame size"]).toBe("1920 x 1080");
    expect(out["Format"]).toBe("video/webm;codecs=vp9");
    expect(out["Frame rate"]).toBe("30 fps");
    expect(out["Bitrate"]).toBe("4.0 Mbps");
  });

  it("formats a non-integer frame rate with one decimal", () => {
    const out = describeRecording({ bytes: 100, durationMs: 1000, fps: 24.4 });
    expect(out["Frame rate"]).toBe("24.4 fps");
  });

  it("falls back to safe defaults for an empty report", () => {
    const out = describeRecording({});
    expect(out["Size"]).toBe("0 B");
    expect(out["Duration"]).toBe("0:00");
    expect(out["Frame size"]).toBe("unknown");
    expect(out["Format"]).toBe("unknown");
    expect(out["Frame rate"]).toBe("unknown");
    expect(out["Bitrate"]).toBe("unknown");
  });

  it("formats an hour-plus duration with an hours component", () => {
    const out = describeRecording({ durationMs: 3_661_000 });
    expect(out["Duration"]).toBe("1:01:01");
  });
});

/* ------------------------------------------------------------------ *
 * patchWebmDuration - synthetic minimal EBML fixtures
 * ------------------------------------------------------------------ */

function el(id: number[], data: number[]): number[] {
  if (data.length > 126) throw new Error("test fixture too large for a 1-byte size vint");
  return [...id, 0x80 | data.length, ...data];
}

function elUnknownSize(id: number[], data: number[]): number[] {
  return [...id, 0xff, ...data];
}

const EBML_HEADER_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const DURATION_ID = [0x44, 0x89];

function buildInfo(withDuration: boolean): number[] {
  const timecodeScale = el(TIMECODE_SCALE_ID, [0x0f, 0x42, 0x40]); // 1,000,000 = default scale
  const duration = withDuration ? el(DURATION_ID, [0, 0, 0, 0, 0, 0, 0, 0]) : [];
  return el(INFO_ID, [...timecodeScale, ...duration]);
}

/** A minimal synthetic WebM: EBML header + an unknown-size Segment > Info. */
function buildWebm(withDuration: boolean): Uint8Array {
  const header = el(EBML_HEADER_ID, []);
  const info = buildInfo(withDuration);
  const segment = elUnknownSize(SEGMENT_ID, info);
  return new Uint8Array([...header, ...segment]);
}

/** Tiny standalone EBML reader (independent of index.ts's parser): scans for
 * the Duration element's byte signature and decodes its float64 value. */
function readDurationValue(bytes: Uint8Array): number {
  for (let i = 0; i <= bytes.length - 11; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8);
      return view.getFloat64(0, false);
    }
  }
  throw new Error("Duration element not found in patched output");
}

describe("patchWebmDuration", () => {
  it("overwrites an existing Duration element's value in place", () => {
    const original = buildWebm(true);
    const patched = patchWebmDuration(original, 2500);
    expect(readDurationValue(patched)).toBe(2500);
    // Fast path: no element grows, so the file length is unchanged.
    expect(patched.length).toBe(original.length);
  });

  it("inserts a Duration element when the Info block does not have one", () => {
    const original = buildWebm(false);
    const patched = patchWebmDuration(original, 12345);
    expect(readDurationValue(patched)).toBe(12345);
    // Inserted element is id(2) + size(1) + data(8) = 11 bytes.
    expect(patched.length).toBe(original.length + 11);
  });

  it("treats a non-positive duration as 0", () => {
    const original = buildWebm(true);
    const patched = patchWebmDuration(original, -5);
    expect(readDurationValue(patched)).toBe(0);
  });

  it("returns the bytes unchanged when there is no recognizable Segment", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    expect(patchWebmDuration(garbage, 1000)).toEqual(garbage);
  });

  it("returns the bytes unchanged when the Segment has no Info block", () => {
    const header = el(EBML_HEADER_ID, []);
    const segment = elUnknownSize(SEGMENT_ID, []);
    const bytes = new Uint8Array([...header, ...segment]);
    expect(patchWebmDuration(bytes, 1000)).toEqual(bytes);
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  it("explains the flow and browser support for empty input", () => {
    const out = run("", { quality: "high", fps: 60, format: "mp4-if-supported" });
    expect(out["Status"]).toMatch(/Draw a rectangle|pick mode/);
    expect(out["Region Capture support"]).toMatch(/Chromium 104/);
    expect(out["Configured quality"]).toMatch(/^high/);
    expect(out["Configured frame rate"]).toBe("60 fps");
    expect(out["Configured export format"]).toMatch(/MP4/);
  });

  it("normalizes an unrecognized quality and invalid fps to defaults", () => {
    const out = run("", { quality: "bogus", fps: Number.NaN, format: "webm" });
    expect(out["Configured quality"]).toMatch(/^medium/);
    expect(out["Configured frame rate"]).toBe("30 fps");
    expect(out["Configured export format"]).toBe("WebM");
  });

  it("throws bad-json on malformed JSON", () => {
    expect(() => run("{not valid", { quality: "low", fps: 30, format: "webm" })).toThrowError(
      ToolError,
    );
    try {
      run("{not valid", { quality: "low", fps: 30, format: "webm" });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-json");
      expect((e as ToolError).fix).toBeDefined();
    }
  });

  it("throws not-a-report for JSON that is not an object", () => {
    try {
      run(JSON.stringify([1, 2, 3]), { quality: "low", fps: 30, format: "webm" });
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("throws not-a-report for an object without recognized fields", () => {
    try {
      run(JSON.stringify({ foo: "bar" }), { quality: "low", fps: 30, format: "webm" });
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("turns a recording report into a labeled summary", () => {
    const report = {
      bytes: 1_000_000,
      durationMs: 5000,
      width: 1280,
      height: 720,
      mimeType: "video/webm",
      fps: 30,
    };
    const out = run(JSON.stringify(report), { quality: "medium", fps: 30, format: "webm" });
    expect(out["Frame size"]).toBe("1280 x 720");
    expect(out["Format"]).toBe("video/webm");
  });

  it("falls back to the configured fps when the report omits it", () => {
    const out = run(JSON.stringify({ bytes: 1000, durationMs: 1000 }), {
      quality: "low",
      fps: 24,
      format: "webm",
    });
    expect(out["Frame rate"]).toBe("24 fps");
  });
});
