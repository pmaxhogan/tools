import { describe, expect, it } from "vitest";
import { formatTimecode, frameName, isBurstError, parseTimeSpec, planBurst, run } from "./index";
import { ToolError } from "../types";

describe("parseTimeSpec", () => {
  it("reads plain seconds, with or without a fraction", () => {
    expect(parseTimeSpec("12")).toBe(12);
    expect(parseTimeSpec("12.5")).toBe(12.5);
    expect(parseTimeSpec("0")).toBe(0);
    expect(parseTimeSpec("  7.25  ")).toBe(7.25);
  });

  it("reads mm:ss and hh:mm:ss.mmm", () => {
    expect(parseTimeSpec("01:12")).toBe(72);
    expect(parseTimeSpec("1:00")).toBe(60);
    expect(parseTimeSpec("00:01:12.500")).toBe(72.5);
    expect(parseTimeSpec("02:00:00")).toBe(7200);
    expect(parseTimeSpec("99:59:59.999")).toBe(359999.999);
  });

  it("accepts a comma as the decimal separator, the way subtitles write it", () => {
    expect(parseTimeSpec("00:01:12,500")).toBe(72.5);
    expect(parseTimeSpec("3,5")).toBe(3.5);
  });

  it("rounds to whole milliseconds", () => {
    expect(parseTimeSpec("1.00049")).toBe(1);
    expect(parseTimeSpec("1.00051")).toBe(1.001);
  });

  it("returns null for anything that is not a time", () => {
    expect(parseTimeSpec("")).toBeNull();
    expect(parseTimeSpec("   ")).toBeNull();
    expect(parseTimeSpec("abc")).toBeNull();
    expect(parseTimeSpec("-5")).toBeNull();
    expect(parseTimeSpec("1:2:3:4")).toBeNull();
    expect(parseTimeSpec("12:")).toBeNull();
    expect(parseTimeSpec("1e3")).toBeNull();
    expect(parseTimeSpec("NaN")).toBeNull();
  });

  it("rejects clock fields that overflow 60 and fractions above the seconds field", () => {
    expect(parseTimeSpec("1:75")).toBeNull();
    expect(parseTimeSpec("00:60:00")).toBeNull();
    expect(parseTimeSpec("1.5:30")).toBeNull();
  });
});

describe("formatTimecode", () => {
  it("prints hh:mm:ss.mmm", () => {
    expect(formatTimecode(0)).toBe("00:00:00.000");
    expect(formatTimecode(12.5)).toBe("00:00:12.500");
    expect(formatTimecode(72.5)).toBe("00:01:12.500");
    expect(formatTimecode(3723.004)).toBe("01:02:03.004");
  });

  it("rounds to whole milliseconds and carries cleanly", () => {
    expect(formatTimecode(59.9996)).toBe("00:01:00.000");
    expect(formatTimecode(3599.9999)).toBe("01:00:00.000");
    expect(formatTimecode(1.0004)).toBe("00:00:01.000");
  });

  it("appends the frame index inside the second when the frame rate is known", () => {
    expect(formatTimecode(12.5, 30)).toBe("00:00:12.500:15");
    expect(formatTimecode(12, 30)).toBe("00:00:12.000:00");
    expect(formatTimecode(1.999, 30)).toBe("00:00:01.999:29");
    expect(formatTimecode(1.999, 23.976)).toBe("00:00:01.999:23");
  });

  it("ignores a frame rate that is not usable and clamps impossible times", () => {
    expect(formatTimecode(5, 0)).toBe("00:00:05.000");
    expect(formatTimecode(5, Number.NaN)).toBe("00:00:05.000");
    expect(formatTimecode(-3)).toBe("00:00:00.000");
    expect(formatTimecode(Number.NaN)).toBe("00:00:00.000");
  });

  it("round trips against parseTimeSpec", () => {
    for (const seconds of [0, 0.001, 12.5, 72.5, 3723.004, 359999.999]) {
      expect(parseTimeSpec(formatTimecode(seconds))).toBe(seconds);
    }
  });
});

describe("frameName", () => {
  it("builds the documented shape", () => {
    expect(frameName("myvideo.mp4", 12.5)).toBe("myvideo-00m12s500.png");
    expect(frameName("My Video.mp4", 12.5)).toBe("my-video-00m12s500.png");
  });

  it("adds an hour field only once the time passes an hour", () => {
    expect(frameName("clip.webm", 3599.999)).toBe("clip-59m59s999.png");
    expect(frameName("clip.webm", 3723.004)).toBe("clip-01h02m03s004.png");
  });

  it("adds a zero padded burst index and honors the extension", () => {
    expect(frameName("clip.mov", 1, 1)).toBe("clip-00m01s000-01.png");
    expect(frameName("clip.mov", 1, 12, "jpg")).toBe("clip-00m01s000-12.jpg");
    expect(frameName("clip.mov", 1, undefined, ".WebP")).toBe("clip-00m01s000.webp");
  });

  it("sanitizes hostile and empty names", () => {
    expect(frameName("../../etc/passwd.mp4", 0)).toBe("etc-passwd-00m00s000.png");
    expect(frameName("", 0)).toBe("video-00m00s000.png");
    expect(frameName("!!!.mkv", 0)).toBe("video-00m00s000.png");
    expect(frameName("a".repeat(80) + ".mp4", 0)).toBe(`${"a".repeat(48)}-00m00s000.png`);
  });

  it("is deterministic for the same inputs", () => {
    expect(frameName("holiday clip.MP4", 61.25, 3, "webp")).toBe(
      frameName("holiday clip.MP4", 61.25, 3, "webp"),
    );
  });
});

describe("planBurst", () => {
  it("spaces frames evenly from the start time", () => {
    const plan = planBurst({ startSec: 2, count: 4, intervalSec: 0.5, durationSec: 60 });
    expect(isBurstError(plan)).toBe(false);
    expect(plan).toEqual({ times: [2, 2.5, 3, 3.5] });
  });

  it("ignores the interval for a single frame", () => {
    expect(planBurst({ startSec: 9.25, count: 1, intervalSec: 0, durationSec: 60 })).toEqual({
      times: [9.25],
    });
  });

  it("accepts a burst whose last frame lands exactly on the end", () => {
    expect(planBurst({ startSec: 8, count: 3, intervalSec: 1, durationSec: 10 })).toEqual({
      times: [8, 9, 10],
    });
  });

  it("skips the end of video checks when the duration is unknown", () => {
    const plan = planBurst({
      startSec: 500,
      count: 2,
      intervalSec: 1,
      durationSec: Number.POSITIVE_INFINITY,
    });
    expect(plan).toEqual({ times: [500, 501] });
  });

  it("rounds accumulated times to whole milliseconds", () => {
    const plan = planBurst({ startSec: 0, count: 3, intervalSec: 0.1, durationSec: 60 });
    expect(plan).toEqual({ times: [0, 0.1, 0.2] });
  });

  it("rejects a start time that is negative or not a number", () => {
    const bad = planBurst({ startSec: -1, count: 1, intervalSec: 1, durationSec: 60 });
    expect(isBurstError(bad)).toBe(true);
    expect(bad).toMatchObject({ error: expect.stringContaining("start time") });
    expect(
      planBurst({ startSec: Number.NaN, count: 1, intervalSec: 1, durationSec: 60 }),
    ).toMatchObject({
      fix: expect.stringContaining("00:00:12.500"),
    });
  });

  it("rejects counts that are not whole numbers in range", () => {
    expect(planBurst({ startSec: 0, count: 0, intervalSec: 1, durationSec: 60 })).toMatchObject({
      error: "The frame count must be a whole number of at least 1.",
    });
    expect(planBurst({ startSec: 0, count: 2.5, intervalSec: 1, durationSec: 60 })).toMatchObject({
      error: "The frame count must be a whole number of at least 1.",
    });
    expect(planBurst({ startSec: 0, count: 31, intervalSec: 1, durationSec: 600 })).toMatchObject({
      error: "A single burst captures at most 30 frames.",
    });
  });

  it("rejects a non positive interval once more than one frame is asked for", () => {
    expect(planBurst({ startSec: 0, count: 2, intervalSec: 0, durationSec: 60 })).toMatchObject({
      error: "The interval between burst frames must be greater than zero.",
    });
    expect(planBurst({ startSec: 0, count: 2, intervalSec: -1, durationSec: 60 })).toMatchObject({
      error: "The interval between burst frames must be greater than zero.",
    });
  });

  it("rejects a start at or past the end of the video", () => {
    const plan = planBurst({ startSec: 10, count: 1, intervalSec: 1, durationSec: 10 });
    expect(plan).toMatchObject({
      error: "The start time is at or past the end of the video.",
      fix: "Pick a start time before 00:00:10.000.",
    });
  });

  it("rejects a burst that would run past the end of the video", () => {
    const plan = planBurst({ startSec: 9, count: 5, intervalSec: 1, durationSec: 10 });
    expect(plan).toMatchObject({ error: "The burst would run past the end of the video." });
    expect(isBurstError(plan) ? plan.fix : "").toContain("00:00:10.000");
  });
});

describe("run", () => {
  it("returns usage rows for an empty input", () => {
    const rows = run("", {});
    expect(rows["Start time"]).toBe("00:00:00.000");
    expect(rows["Burst plan"]).toBe("1 frame at 00:00:00.000");
    expect(rows["File names"]).toBe("video-00m00s000.png");
    expect(rows.Format).toContain("lossless");
    expect(rows["Seeking precision"]).toContain("nearest decodable frame");
  });

  it("reads a typed time as the burst start and plans from it", () => {
    const rows = run("00:00:12.500", { count: 3, interval: "0.5", format: "jpeg", quality: 80 });
    expect(rows["Start time"]).toBe("00:00:12.500");
    expect(rows["Burst plan"]).toContain("00:00:13.500");
    expect(rows["File names"]).toBe(
      "video-00m12s500-01.jpg, video-00m13s000-02.jpg, video-00m13s500-03.jpg",
    );
    expect(rows.Format).toBe("JPEG at quality 80");
  });

  it("describes dropped bytes instead of pretending to decode them", () => {
    const rows = run(new Uint8Array(2048), {});
    expect(rows.Input).toContain("2,048 bytes");
    expect(rows.Resolution).toContain("video's own pixel size");
  });

  it("throws ToolError for a time it cannot read", () => {
    expect(() => run("halfway", {})).toThrowError(ToolError);
    try {
      run("halfway", {});
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("invalid-time");
      expect((e as ToolError).fix).toContain("hh:mm:ss.mmm");
    }
  });

  it("throws ToolError for an unreadable interval", () => {
    try {
      run("", { interval: "often" });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("invalid-interval");
    }
    expect.assertions(2);
  });

  it("throws ToolError when the burst request itself is impossible", () => {
    try {
      run("", { count: 99 });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("invalid-burst");
      expect((e as ToolError).message).toBe("A single burst captures at most 30 frames.");
    }
    expect.assertions(3);
  });
});
