import { describe, expect, it } from "vitest";
import { chooseRecorderMime, formatSeconds, parseTimeSpec, planTrim, run } from "./index";
import { ToolError } from "../types";

describe("parseTimeSpec", () => {
  it("parses bare seconds with and without a fraction", () => {
    expect(parseTimeSpec("0")).toBe(0);
    expect(parseTimeSpec("12")).toBe(12);
    expect(parseTimeSpec("12.5")).toBe(12.5);
    expect(parseTimeSpec("  7.25  ")).toBe(7.25);
  });

  it("parses mm:ss and hh:mm:ss.mmm", () => {
    expect(parseTimeSpec("1:02")).toBe(62);
    expect(parseTimeSpec("1:02.5")).toBe(62.5);
    expect(parseTimeSpec("00:01:02.500")).toBe(62.5);
    expect(parseTimeSpec("2:00:00")).toBe(7200);
  });

  it("accepts a comma as the decimal separator", () => {
    expect(parseTimeSpec("00:00:01,250")).toBe(1.25);
  });

  it("returns null for things that are not times", () => {
    expect(parseTimeSpec("")).toBeNull();
    expect(parseTimeSpec("   ")).toBeNull();
    expect(parseTimeSpec("abc")).toBeNull();
    expect(parseTimeSpec("-3")).toBeNull();
    expect(parseTimeSpec("1:2:3:4")).toBeNull();
    // Minutes and seconds fields may not overflow into the next unit.
    expect(parseTimeSpec("1:75")).toBeNull();
    // Only the last field may carry a fraction.
    expect(parseTimeSpec("1.5:02")).toBeNull();
  });
});

describe("planTrim frame math", () => {
  it("floors the start frame and ceils the end frame", () => {
    expect(planTrim({ durationSec: 10, startSec: 1.5, endSec: 2.5, fps: 30 })).toEqual({
      startFrame: 45,
      endFrame: 75,
      frameCount: 30,
      outDurationSec: 1,
    });
  });

  it("keeps every frame a fractional boundary touches", () => {
    // 1.51s lands inside frame 45, and 2.51s lands inside frame 75, so both
    // of those frames stay in the range.
    const plan = planTrim({ durationSec: 10, startSec: 1.51, endSec: 2.51, fps: 30 });
    expect(plan).toMatchObject({ startFrame: 45, endFrame: 76, frameCount: 31 });
    expect((plan as { outDurationSec: number }).outDurationSec).toBeCloseTo(1, 9);
  });

  it("handles a whole clip at 24 fps", () => {
    expect(planTrim({ durationSec: 5, startSec: 0, endSec: 5, fps: 24 })).toEqual({
      startFrame: 0,
      endFrame: 120,
      frameCount: 120,
      outDurationSec: 5,
    });
  });

  it("rejects a duration that is not positive", () => {
    const plan = planTrim({ durationSec: 0, startSec: 0, endSec: 1, fps: 30 });
    expect(plan).toMatchObject({ error: expect.stringContaining("duration") });
  });

  it("rejects times that are not numbers", () => {
    const plan = planTrim({ durationSec: 10, startSec: NaN, endSec: 2, fps: 30 });
    expect(plan).toMatchObject({ error: expect.stringContaining("numbers of seconds") });
  });

  it("rejects a frame rate that is not positive", () => {
    const plan = planTrim({ durationSec: 10, startSec: 0, endSec: 1, fps: 0 });
    expect(plan).toMatchObject({ error: expect.stringContaining("frame rate") });
  });

  it("rejects a start before zero", () => {
    const plan = planTrim({ durationSec: 10, startSec: -1, endSec: 2, fps: 30 });
    expect(plan).toMatchObject({ error: expect.stringContaining("before the beginning") });
  });

  it("rejects an end past the clip", () => {
    const plan = planTrim({ durationSec: 10, startSec: 1, endSec: 11, fps: 30 });
    expect(plan).toMatchObject({ error: expect.stringContaining("past the end") });
  });

  it("rejects an end that is not after the start", () => {
    const plan = planTrim({ durationSec: 10, startSec: 4, endSec: 4, fps: 30 });
    expect(plan).toMatchObject({ error: expect.stringContaining("not after the start") });
  });
});

describe("chooseRecorderMime", () => {
  it("prefers VP9 when the browser supports it", () => {
    expect(chooseRecorderMime(() => true)).toBe("video/webm;codecs=vp9");
  });

  it("falls back to VP8 when VP9 is missing", () => {
    const supported = (type: string) => !type.includes("vp9");
    expect(chooseRecorderMime(supported)).toBe("video/webm;codecs=vp8");
  });

  it("falls back to plain WebM when neither codec is named", () => {
    const supported = (type: string) => type === "video/webm";
    expect(chooseRecorderMime(supported)).toBe("video/webm");
  });

  it("returns null when nothing is supported", () => {
    expect(chooseRecorderMime(() => false)).toBeNull();
  });

  it("treats a predicate that throws as unsupported", () => {
    expect(
      chooseRecorderMime((type) => {
        if (type !== "video/webm") throw new Error("bad type");
        return true;
      }),
    ).toBe("video/webm");
  });
});

describe("formatSeconds", () => {
  it("drops the hours field until it is needed", () => {
    expect(formatSeconds(0)).toBe("0:00.000");
    expect(formatSeconds(62.5)).toBe("1:02.500");
    expect(formatSeconds(3661.25)).toBe("1:01:01.250");
  });

  it("clamps values that are not usable times", () => {
    expect(formatSeconds(-4)).toBe("0:00.000");
    expect(formatSeconds(NaN)).toBe("0:00.000");
  });
});

describe("run", () => {
  it("returns the plan rows for a JSON clip description", () => {
    const rows = run('{"durationSec": 10, "start": "1.5", "end": "2.5", "fps": 30}', {});
    expect(rows).toEqual({
      "Source duration": "0:10.000 (10 s)",
      "Frame rate": "30 fps",
      Start: "0:01.500 (frame 45)",
      End: "0:02.500 (frame 75)",
      Frames: "30",
      "Trimmed duration": "0:01.000 (1 s)",
    });
  });

  it("falls back to the tool options when the JSON omits a field", () => {
    const rows = run('{"durationSec": 10}', { start: "0:02", end: "0:04", fps: 25 });
    expect(rows.Start).toBe("0:02.000 (frame 50)");
    expect(rows.End).toBe("0:04.000 (frame 100)");
    expect(rows.Frames).toBe("50");
  });

  it("treats an empty end as the end of the clip", () => {
    const rows = run('{"durationSec": 10}', { start: "0", end: "", fps: 30 });
    expect(rows.End).toBe("0:10.000 (frame 300)");
    expect(rows["Trimmed duration"]).toBe("0:10.000 (10 s)");
  });

  it("refuses a dropped video file and points at the panel", () => {
    expect(() => run(new Uint8Array([0, 1, 2]), {})).toThrow(ToolError);
    try {
      run(new Uint8Array([0, 1, 2]), {});
    } catch (e) {
      expect((e as ToolError).code).toBe("needs-panel");
      expect((e as ToolError).fix).toContain("durationSec");
    }
  });

  it("refuses empty input", () => {
    try {
      run("   ", {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("refuses input that is not JSON", () => {
    try {
      run("not json", {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
    }
  });

  it("refuses JSON that is not an object", () => {
    try {
      run("[1, 2, 3]", {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
    }
  });

  it("refuses JSON with no duration", () => {
    try {
      run('{"start": "1", "end": "2"}', {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-duration");
    }
  });

  it("turns an impossible range into a ToolError with a fix", () => {
    try {
      run('{"durationSec": 5, "start": "4", "end": "2"}', {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-range");
      expect((e as ToolError).fix).toContain("end marker");
    }
  });
});
